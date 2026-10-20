import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { badRequest, conflict, notFound } from "../lib/errors";
import { isUniqueViolation } from "../lib/db-errors";
import { mesAnterior, utcToLocalDateString } from "../lib/time";
import { formatearHorarios } from "../lib/horarios";
import {
  activities,
  activitySchedules,
  appointments,
  subscriptionBillingCycles,
  subscriptionMonthSchedules,
  trainingSubscriptions,
} from "../db/schema";
import { asegurarCicloDelMes, bloquearCiclo } from "../repositories/cuotas.repo";
import { listClassesForRange } from "../repositories/classes.repo";

export type AnotarAlMesInput = {
  activityId: string;
  customerId: string;
  /** YYYY-MM */
  mes: string;
  scheduleIds: string[];
  cuota: number;
  /** Sólo para tests: la ruta no lo expone. */
  ahora?: Date;
};

export type ResultadoAlMes = {
  subscriptionId: string;
  billingCycleId: string;
  anotadas: number;
  /** startsAt ISO de las clases que no tenían lugar */
  sinLugar: string[];
  superaPlan: boolean;
  clasesDelMes: number;
};

function nombreDelMes(mes: string): string {
  return new Date(`${mes}-01T00:00:00Z`).toLocaleDateString("es-AR", { month: "long", timeZone: "UTC" });
}

/** Lo primero de toda anotación: serializa con cualquier otra a la misma actividad. Una sola fila, sin deadlocks. */
async function bloquearActividad(t: Db, activityId: string) {
  const [actividad] = await t
    .select({
      name: activities.name,
      classesPerMonth: activities.classesPerMonth,
      providerId: activities.serviceProviderId,
    })
    .from(activities)
    .where(eq(activities.id, activityId))
    .for("update")
    .limit(1);
  return actividad;
}

/** Lugares ocupados de UNA clase: misma actividad, mismo inicio y misma máquina (NULL con NULL). */
async function lugaresOcupados(t: Db, activityId: string, inicio: Date, machineId: string | null): Promise<number> {
  const [fila] = (await t.execute(sql`
    SELECT COUNT(*)::int AS n FROM appointments
    WHERE activity_id = ${activityId}
      AND appointment_start = ${inicio.toISOString()}::timestamptz
      AND machine_id IS NOT DISTINCT FROM ${machineId}::uuid
      AND status <> 'cancelled'
  `)) as unknown as { n: number }[];
  return fila!.n;
}

function minutos(hhmmss: string): number {
  const [h, m] = hhmmss.split(":").map(Number);
  return h! * 60 + m!;
}

function mesSiguiente(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return m === 12 ? `${a! + 1}-01` : `${a}-${String(m! + 1).padStart(2, "0")}`;
}

/**
 * Anota a una clienta al mes en los horarios semanales que eligió.
 *
 * Todo en UNA transacción. Lo crítico es el cupo: lo primero que se hace es
 * bloquear la fila de la ACTIVIDAD (`FOR UPDATE`), así dos anotaciones a la misma
 * actividad se serializan y la segunda ve los lugares que ocupó la primera. Es una
 * sola fila por operación, así que no hay deadlocks. Después se bloquea el ciclo
 * del mes (orden: actividad → ciclo).
 *
 * El cupo de una clase se cuenta por actividad + inicio + máquina del horario:
 * en Thermo Bike dos máquinas a la misma hora son dos clases, cada una con su cupo.
 */
export async function anotarAlMes(db: Db, input: AnotarAlMesInput): Promise<ResultadoAlMes> {
  const ahora = input.ahora ?? new Date();
  const hoy = utcToLocalDateString(ahora);
  const mesActual = hoy.slice(0, 7);
  const { mes, activityId, customerId, cuota } = input;
  const scheduleIds = [...new Set(input.scheduleIds)].sort();

  if (mes !== mesActual && mes !== mesSiguiente(mesActual)) {
    throw badRequest("Sólo se puede anotar al mes actual o al siguiente");
  }
  if (scheduleIds.length < 1) throw badRequest("Ese horario no es de esta actividad o no está vigente");

  try {
    return await db.transaction(async (tx) => {
      const t = tx as unknown as Db;

      // Lo primero: serializar con cualquier otra anotación a esta actividad.
      const actividad = await bloquearActividad(t, activityId);

      // Clases del mes entero de la actividad (la misma lógica de vigencia que la grilla).
      const [anio, nMes] = mes.split("-").map(Number);
      const ultimo = new Date(Date.UTC(anio!, nMes!, 0)).getUTCDate();
      const todas = await listClassesForRange(t, `${mes}-01`, `${mes}-${String(ultimo).padStart(2, "0")}`);
      const delMes = todas.filter(
        (c) =>
          c.kind === "activity" &&
          c.subject_id === activityId &&
          c.schedule_id !== null &&
          scheduleIds.includes(c.schedule_id),
      );
      const vigentes = new Set(delMes.map((c) => c.schedule_id));
      if (!scheduleIds.every((id) => vigentes.has(id))) {
        throw badRequest("Ese horario no es de esta actividad o no está vigente");
      }


      // Suscripción activa; si sólo hay una pausada, no se anota.
      const subs = await t
        .select({ id: trainingSubscriptions.id, status: trainingSubscriptions.status })
        .from(trainingSubscriptions)
        .where(and(eq(trainingSubscriptions.customerId, customerId), eq(trainingSubscriptions.activityId, activityId)));
      const activa = subs.find((s) => s.status === "active");
      if (!activa && subs.some((s) => s.status === "paused")) throw badRequest("La suscripción está pausada");

      let subscriptionId = activa?.id;
      if (!subscriptionId) {
        const [nueva] = await t
          .insert(trainingSubscriptions)
          .values({
            activityId,
            customerId,
            status: "active",
            monthlyAmount: cuota.toFixed(2),
            subscriptionStartDate: mes === mesActual ? hoy : `${mes}-01`,
          })
          .returning({ id: trainingSubscriptions.id });
        subscriptionId = nueva!.id;
      }

      // El ciclo nace con amount_due = cuota. Se bloquea antes de mirar si ya está anotada.
      const billingCycleId = await asegurarCicloDelMes(t, subscriptionId, mes, cuota);
      await bloquearCiclo(t, billingCycleId);
      const yaAnotada = await t
        .select({ id: subscriptionMonthSchedules.activityScheduleId })
        .from(subscriptionMonthSchedules)
        .where(eq(subscriptionMonthSchedules.billingCycleId, billingCycleId))
        .limit(1);
      if (yaAnotada.length > 0) {
        throw conflict(`Ya está anotada a ${nombreDelMes(mes)}`);
      }
      // Un ciclo que ya existía impago toma la cuota nueva; uno pagado no se toca.
      await t
        .update(subscriptionBillingCycles)
        .set({ amountDue: cuota.toFixed(2), updatedAt: new Date() })
        .where(
          and(
            eq(subscriptionBillingCycles.id, billingCycleId),
            sql`${subscriptionBillingCycles.isPaid} IS NOT TRUE`,
            sql`${subscriptionBillingCycles.amountDue} IS DISTINCT FROM ${cuota.toFixed(2)}::numeric`,
          ),
        );

      await t
        .insert(subscriptionMonthSchedules)
        .values(scheduleIds.map((id) => ({ billingCycleId, activityScheduleId: id })));

      // Cupo de cada horario (la actividad ya está bloqueada, no hace falta bloquear cada fila).
      const horarios = await t
        .select({ id: activitySchedules.id, capacity: activitySchedules.capacity })
        .from(activitySchedules)
        .where(sql`${activitySchedules.id} IN (${sql.join(scheduleIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
      const cupoDe = new Map(horarios.map((h) => [h.id, h.capacity]));

      let anotadas = 0;
      const sinLugar: string[] = [];
      const futuras = delMes
        .filter((c) => new Date(c.starts_at_utc).getTime() > ahora.getTime())
        .sort((a, b) => new Date(a.starts_at_utc).getTime() - new Date(b.starts_at_utc).getTime());

      for (const clase of futuras) {
        const inicio = new Date(clase.starts_at_utc);

        const ya = await t
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.customerId, customerId),
              eq(appointments.activityId, activityId),
              eq(appointments.appointmentStart, inicio),
              sql`${appointments.status} <> 'cancelled'`,
            ),
          )
          .limit(1);
        if (ya.length > 0) continue;

        // Lugares ocupados de ESTA clase: misma actividad, mismo inicio y misma máquina (NULL con NULL).
        const capacidad = cupoDe.get(clase.schedule_id!) ?? null;
        if (capacidad !== null) {
          if ((await lugaresOcupados(t, activityId, inicio, clase.machine_id)) >= capacidad) {
            sinLugar.push(inicio.toISOString());
            continue;
          }
        }

        const duracion = minutos(clase.end_time) - minutos(clase.start_time);
        await t.insert(appointments).values({
          customerId,
          activityId,
          serviceProviderId: actividad?.providerId ?? null,
          machineId: clase.machine_id,
          appointmentStart: inicio,
          appointmentEnd: new Date(inicio.getTime() + duracion * 60_000),
          durationMinutes: duracion,
          status: "scheduled",
          isTrial: false,
        });
        anotadas++;
      }

      const clasesDelMes = delMes.length;
      const plan = actividad?.classesPerMonth ?? 0;
      return {
        subscriptionId,
        billingCycleId,
        anotadas,
        sinLugar,
        superaPlan: plan > 0 && clasesDelMes > plan,
        clasesDelMes,
      };
    });
  } catch (err) {
    // Los índices únicos son la última red: se traducen a 409, nunca 500.
    if (isUniqueViolation(err, "ux_appt_clase_actividad")) throw conflict("Ya está anotada en esa clase");
    if (isUniqueViolation(err, "uq_training_subscriptions_customer_training_active")) {
      throw conflict("Se cruzó con otra anotación de esta clienta: probá de nuevo");
    }
    throw err;
  }
}

/**
 * Renueva el mes de una suscripción: repite los horarios del ciclo del mes anterior y cobra
 * `monthly_amount`. No reimplementa nada: es `anotarAlMes` (con su lock, cupo y reglas) con los datos
 * de la suscripción; la validación de pausada/ya anotada sigue siendo la suya.
 */
export async function renovar(
  db: Db,
  input: { subscriptionId: string; mes: string; ahora?: Date },
): Promise<ResultadoAlMes> {
  const [sub] = await db
    .select({
      activityId: trainingSubscriptions.activityId,
      customerId: trainingSubscriptions.customerId,
      monthlyAmount: trainingSubscriptions.monthlyAmount,
      status: trainingSubscriptions.status,
    })
    .from(trainingSubscriptions)
    .where(eq(trainingSubscriptions.id, input.subscriptionId))
    .limit(1);
  if (!sub) throw notFound("Subscription");
  // Sin esto, anotarAlMes (que busca sólo la ACTIVA) crearía una suscripción nueva para una cancelada.
  if (sub.status === "cancelled") throw badRequest("La suscripción está cancelada");
  if (sub.status === "paused") throw badRequest("La suscripción está pausada");
  if (!sub.customerId || !sub.activityId) throw badRequest("La suscripción no tiene clienta o actividad");

  const previos = await db
    .select({ id: subscriptionMonthSchedules.activityScheduleId })
    .from(subscriptionBillingCycles)
    .innerJoin(subscriptionMonthSchedules, eq(subscriptionMonthSchedules.billingCycleId, subscriptionBillingCycles.id))
    .where(
      and(
        eq(subscriptionBillingCycles.trainingSubscriptionId, input.subscriptionId),
        eq(subscriptionBillingCycles.billingMonth, mesAnterior(input.mes)),
      ),
    );
  if (previos.length === 0) throw badRequest("No tiene horarios del mes anterior para repetir");

  return anotarAlMes(db, {
    activityId: sub.activityId,
    customerId: sub.customerId,
    mes: input.mes,
    scheduleIds: previos.map((p) => p.id),
    cuota: Number(sub.monthlyAmount ?? 0),
    ahora: input.ahora,
  });
}

// ---------------------------------------------------------------------------
// Sumar a UNA clase: pase libre (anotada al mes) o clase de prueba
// ---------------------------------------------------------------------------

export type AnotarAClaseInput = {
  activityId: string;
  /** Instante de inicio de la clase (ISO), tal como lo expone `classes` en `startsAt`. */
  startsAt: string;
  customerId: string;
  prueba?: boolean;
  /** Sólo para tests: la ruta no lo expone. */
  ahora?: Date;
};

/** ¿Tiene turno de prueba (no cancelado) en esta actividad? */
async function tuvoPrueba(t: Db, customerId: string, activityId: string): Promise<boolean> {
  const r = await t
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.customerId, customerId),
        eq(appointments.activityId, activityId),
        eq(appointments.isTrial, true),
        sql`${appointments.status} <> 'cancelled'`,
      ),
    )
    .limit(1);
  return r.length > 0;
}

/** El ciclo del mes de su suscripción ACTIVA tiene al menos un horario elegido. */
async function horariosElegidosDelMes(t: Db, subscriptionId: string, mes: string) {
  return t
    .select({ dayOfWeek: activitySchedules.dayOfWeek, startTime: activitySchedules.startTime })
    .from(subscriptionBillingCycles)
    .innerJoin(subscriptionMonthSchedules, eq(subscriptionMonthSchedules.billingCycleId, subscriptionBillingCycles.id))
    .innerJoin(activitySchedules, eq(activitySchedules.id, subscriptionMonthSchedules.activityScheduleId))
    .where(and(eq(subscriptionBillingCycles.trainingSubscriptionId, subscriptionId), eq(subscriptionBillingCycles.billingMonth, mes)));
}

/**
 * Suma a una clienta a una clase puntual. Sin `prueba` es el "pase libre": tiene que estar anotada al
 * mes de esa clase. Con `prueba` es su clase de prueba (una sola por actividad, y sólo si nunca fue suscriptora).
 * Misma serialización que `anotarAlMes`: primero la fila de la actividad con FOR UPDATE.
 */
export async function anotarAClase(db: Db, input: AnotarAClaseInput): Promise<{ appointmentId: string }> {
  const ahora = input.ahora ?? new Date();
  const { activityId, customerId } = input;
  const inicio = new Date(input.startsAt);
  if (Number.isNaN(inicio.getTime())) throw badRequest("Fecha de clase inválida");

  try {
    return await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const actividad = await bloquearActividad(t, activityId);
      if (!actividad) throw badRequest("No hay clase en ese horario");
      const sinClase = () => badRequest(`No hay clase de ${actividad.name} en ese horario`);

      // La clase tiene que existir: misma lógica de vigencia que la grilla, inicio exacto.
      const fecha = utcToLocalDateString(inicio);
      const delDia = await listClassesForRange(t, fecha, fecha);
      const candidatas = delDia.filter(
        (c) =>
          c.kind === "activity" &&
          c.subject_id === activityId &&
          c.schedule_id !== null &&
          new Date(c.starts_at_utc).getTime() === inicio.getTime(),
      );
      if (candidatas.length === 0) throw sinClase();
      if (inicio.getTime() <= ahora.getTime()) throw badRequest("Esa clase ya pasó");

      const mes = fecha.slice(0, 7);
      const subs = await t
        .select({ id: trainingSubscriptions.id, status: trainingSubscriptions.status })
        .from(trainingSubscriptions)
        .where(and(eq(trainingSubscriptions.customerId, customerId), eq(trainingSubscriptions.activityId, activityId)));

      if (input.prueba) {
        if (subs.length > 0) throw conflict(`Ya está suscripta a ${actividad.name}: sumala con el pase libre`);
        if (await tuvoPrueba(t, customerId, activityId)) throw conflict(`Ya tuvo su clase de prueba de ${actividad.name}`);
      } else {
        const activa = subs.find((s) => s.status === "active");
        const elegidos = activa ? await horariosElegidosDelMes(t, activa.id, mes) : [];
        if (elegidos.length === 0) {
          throw badRequest(`No está anotada a ${nombreDelMes(mes)}: anotala al mes o como prueba`);
        }
      }

      const ya = await t
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.customerId, customerId),
            eq(appointments.activityId, activityId),
            eq(appointments.appointmentStart, inicio),
            sql`${appointments.status} <> 'cancelled'`,
          ),
        )
        .limit(1);
      if (ya.length > 0) throw conflict("Ya está anotada en esa clase");

      // Si hay dos máquinas a la misma hora, la primera con lugar.
      let elegida: (typeof candidatas)[number] | undefined;
      for (const c of candidatas) {
        const [h] = await t
          .select({ capacity: activitySchedules.capacity })
          .from(activitySchedules)
          .where(eq(activitySchedules.id, c.schedule_id!))
          .limit(1);
        const capacidad = h?.capacity ?? null;
        if (capacidad === null || (await lugaresOcupados(t, activityId, inicio, c.machine_id)) < capacidad) {
          elegida = c;
          break;
        }
      }
      if (!elegida) throw conflict("La clase está llena");

      const duracion = minutos(elegida.end_time) - minutos(elegida.start_time);
      const [turno] = await t
        .insert(appointments)
        .values({
          customerId,
          activityId,
          serviceProviderId: actividad.providerId ?? null,
          machineId: elegida.machine_id,
          appointmentStart: inicio,
          appointmentEnd: new Date(inicio.getTime() + duracion * 60_000),
          durationMinutes: duracion,
          status: "scheduled",
          isTrial: input.prueba === true,
        })
        .returning({ id: appointments.id });
      return { appointmentId: turno!.id };
    });
  } catch (err) {
    if (isUniqueViolation(err, "ux_appt_clase_actividad")) throw conflict("Ya está anotada en esa clase");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Qué se le puede ofrecer a una clienta en una actividad (spec §3.1)
// ---------------------------------------------------------------------------


export type OpcionesParaAnotar = {
  anotadaAlMes: boolean;
  suscripcion: "activa" | "pausada" | null;
  puedePrueba: boolean;
  cuotaSugerida: number;
  /** "Lun 10:00", de lunes a domingo y por hora */
  horariosDelMes: string[];
};

export async function opcionesParaAnotar(
  db: Db,
  input: { activityId: string; customerId: string; mes: string },
): Promise<OpcionesParaAnotar> {
  const { activityId, customerId, mes } = input;
  const subs = await db
    .select({ id: trainingSubscriptions.id, status: trainingSubscriptions.status, monthlyAmount: trainingSubscriptions.monthlyAmount })
    .from(trainingSubscriptions)
    .where(and(eq(trainingSubscriptions.customerId, customerId), eq(trainingSubscriptions.activityId, activityId)));
  const activa = subs.find((s) => s.status === "active");
  const pausada = subs.find((s) => s.status === "paused");

  const elegidos = activa ? await horariosElegidosDelMes(db, activa.id, mes) : [];
  const horariosDelMes = formatearHorarios(elegidos);

  let cuotaSugerida: number;
  const suya = activa ?? pausada;
  if (suya?.monthlyAmount != null) cuotaSugerida = Number(suya.monthlyAmount);
  else {
    const [a] = await db
      .select({ precio: activities.monthlyBasePrice })
      .from(activities)
      .where(eq(activities.id, activityId))
      .limit(1);
    cuotaSugerida = a?.precio != null ? Number(a.precio) : 0;
  }

  return {
    anotadaAlMes: horariosDelMes.length > 0,
    suscripcion: activa ? "activa" : pausada ? "pausada" : null,
    puedePrueba: subs.length === 0 && !(await tuvoPrueba(db, customerId, activityId)),
    cuotaSugerida,
    horariosDelMes,
  };
}

// ---------------------------------------------------------------------------
// Anotar a una capacitación: un turno en cada encuentro que todavía no pasó
// ---------------------------------------------------------------------------

export type ResultadoACapacitacion = {
  anotada: number;
  yaEstaba: number;
  /** session_number de los encuentros que no tenían lugar */
  sinLugar: number[];
};

/**
 * Anota a una clienta que compró la capacitación en todos los encuentros activos que quedan.
 *
 * Misma serialización que las otras anotaciones: lo primero es bloquear la fila de la CAPACITACIÓN
 * (`FOR UPDATE`), así dos anotaciones a la misma capacitación se ven los lugares una a la otra y no
 * se pasa el cupo. Una sola fila por operación, sin deadlocks. Los encuentros pasados o dados de baja
 * se saltean; los llenos no frenan nada: vuelven en `sinLugar`.
 */
export async function anotarACapacitacion(
  db: Db,
  input: { trainingId: string; customerId: string; ahora?: Date },
): Promise<ResultadoACapacitacion> {
  const ahora = input.ahora ?? new Date();
  const { trainingId, customerId } = input;

  return await db.transaction(async (tx) => {
    const t = tx as unknown as Db;

    // Lo primero: serializar con cualquier otra anotación a esta capacitación.
    const capacitacion = (await t.execute(sql`
      SELECT max_participants FROM training WHERE id = ${trainingId}::uuid FOR UPDATE
    `)) as unknown as { max_participants: number | null }[];
    if (capacitacion.length === 0) throw badRequest("No existe esa capacitación");

    const compra = (await t.execute(sql`
      SELECT 1 AS ok FROM customer_purchase
      WHERE customer_id = ${customerId}::uuid AND training_id = ${trainingId}::uuid AND cancelled_at IS NULL
      LIMIT 1
    `)) as unknown as unknown[];
    if (compra.length === 0) throw badRequest("No compró esta capacitación");

    // El inicio del encuentro es hora local ART; "ya pasó" se compara contra el instante real.
    const encuentros = (await t.execute(sql`
      SELECT ts.id, ts.session_number, ts.service_provider_id,
             ts.start_time::text AS start_time, ts.end_time::text AS end_time,
             ((ts.session_date + ts.start_time) AT TIME ZONE 'America/Argentina/Buenos_Aires') AS inicio,
             COALESCE(ts.capacity, ${capacitacion[0]!.max_participants}::int) AS cupo
      FROM training_sessions ts
      WHERE ts.training_id = ${trainingId}::uuid
        AND ts.is_active
        AND ((ts.session_date + ts.start_time) AT TIME ZONE 'America/Argentina/Buenos_Aires') > ${ahora.toISOString()}::timestamptz
      ORDER BY ts.session_number
    `)) as unknown as {
      id: string;
      session_number: number | null;
      service_provider_id: string | null;
      start_time: string;
      end_time: string;
      inicio: Date | string;
      cupo: number | null;
    }[];

    let anotada = 0;
    let yaEstaba = 0;
    const sinLugar: number[] = [];

    for (const e of encuentros) {
      const ya = await t
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.customerId, customerId),
            eq(appointments.trainingSessionId, e.id),
            sql`${appointments.status} <> 'cancelled'`,
          ),
        )
        .limit(1);
      if (ya.length > 0) {
        yaEstaba++;
        continue;
      }

      if (e.cupo !== null) {
        const [fila] = (await t.execute(sql`
          SELECT COUNT(*)::int AS n FROM appointments
          WHERE training_session_id = ${e.id}::uuid AND status <> 'cancelled'
        `)) as unknown as { n: number }[];
        if (fila!.n >= e.cupo) {
          sinLugar.push(e.session_number ?? 1);
          continue;
        }
      }

      const inicio = new Date(e.inicio);
      const duracion = minutos(e.end_time) - minutos(e.start_time);
      try {
        // Savepoint: si el índice único salta, la transacción entera sigue viva.
        await t.transaction(async (sp) => {
          await (sp as unknown as Db).insert(appointments).values({
            customerId,
            trainingSessionId: e.id,
            serviceProviderId: e.service_provider_id,
            appointmentStart: inicio,
            appointmentEnd: new Date(inicio.getTime() + duracion * 60_000),
            durationMinutes: duracion,
            status: "scheduled",
            isTrial: false,
          });
        });
        anotada++;
      } catch (err) {
        // Doble anotación que se coló: ya estaba, no es un error.
        if (!isUniqueViolation(err, "ux_appt_encuentro")) throw err;
        yaEstaba++;
      }
    }

    return { anotada, yaEstaba, sinLugar };
  });
}
