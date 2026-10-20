import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { badRequest, conflict } from "../lib/errors";
import { isUniqueViolation } from "../lib/db-errors";
import { utcToLocalDateString } from "../lib/time";
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
      const [actividad] = await t
        .select({
          classesPerMonth: activities.classesPerMonth,
          providerId: activities.serviceProviderId,
        })
        .from(activities)
        .where(eq(activities.id, activityId))
        .for("update")
        .limit(1);

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
        const nombreMes = new Date(`${mes}-01T00:00:00Z`).toLocaleDateString("es-AR", {
          month: "long",
          timeZone: "UTC",
        });
        throw conflict(`Ya está anotada a ${nombreMes}`);
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
          const [fila] = (await t.execute(sql`
            SELECT COUNT(*)::int AS n FROM appointments
            WHERE activity_id = ${activityId}
              AND appointment_start = ${inicio.toISOString()}::timestamptz
              AND machine_id IS NOT DISTINCT FROM ${clase.machine_id}::uuid
              AND status <> 'cancelled'
          `)) as unknown as { n: number }[];
          if (fila!.n >= capacidad) {
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
