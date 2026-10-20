import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { badRequest, conflict } from "../lib/errors";
import { utcToLocalDateString } from "../lib/time";
import {
  activities,
  appointments,
  subscriptionBillingCycles,
  subscriptionMonthSchedules,
  trainingSubscriptions,
} from "../db/schema";
import { asegurarCicloDelMes } from "../repositories/cuotas.repo";
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

const SUBS_UNICA = "uq_training_subscriptions_customer_training_active";

function esUnique(err: unknown, constraint?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown; cause?: { code?: unknown; constraint_name?: unknown } };
  const code = e.code ?? e.cause?.code;
  const nombre = e.constraint_name ?? e.cause?.constraint_name;
  return code === "23505" && (!constraint || nombre === constraint);
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
 * Todo en UNA transacción. Lo crítico es el cupo: antes de contar los lugares de
 * una clase se bloquea la fila de su horario (`FOR UPDATE`), así dos anotaciones
 * simultáneas a la última plaza se serializan y la segunda ve el lugar ocupado.
 * Los horarios se bloquean todos juntos y en orden de id para no entrar en deadlock.
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
  if (scheduleIds.length < 1) throw badRequest("Elegí al menos un horario");

  try {
    return await db.transaction(async (tx) => {
      const t = tx as unknown as Db;

      // Clases del mes entero de la actividad (la misma lógica de vigencia que la grilla).
      const [anio, nMes] = mes.split("-").map(Number);
      const ultimo = new Date(Date.UTC(anio!, nMes!, 0)).getUTCDate();
      const todas = await listClassesForRange(t, `${mes}-01`, `${mes}-${String(ultimo).padStart(2, "0")}`);
      const delMes = todas.filter(
        (c) =>
          c.kind === "activity" &&
          c.subject_id === activityId &&
          scheduleIds.some((id) => c.occurrence_id.startsWith(`activity-${id}-`)),
      );
      const vigentes = new Set(delMes.map((c) => c.occurrence_id.slice(9, 45)));
      // El id de horario es un uuid (5 grupos): ya está en occurrence_id entre "activity-" y la fecha.
      if (!scheduleIds.every((id) => vigentes.has(id))) {
        throw badRequest("Ese horario no es de esta actividad o no está vigente");
      }

      // Bloqueo de todos los horarios, en orden de id, ANTES de escribir nada: el insert en
      // subscription_month_schedules toma un FOR KEY SHARE sobre el horario (por la FK) y, si
      // pidiéramos el FOR UPDATE después, dos anotaciones simultáneas se trabarían entre sí (deadlock).
      for (const id of scheduleIds) {
        await t.execute(sql`SELECT id FROM activity_schedules WHERE id = ${id} FOR UPDATE`);
      }

      const [actividad] = await t
        .select({
          classesPerMonth: activities.classesPerMonth,
          providerId: activities.serviceProviderId,
        })
        .from(activities)
        .where(eq(activities.id, activityId))
        .limit(1);

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

      const billingCycleId = await asegurarCicloDelMes(t, subscriptionId, mes, cuota);
      const [ciclo] = await t
        .select({ isPaid: subscriptionBillingCycles.isPaid })
        .from(subscriptionBillingCycles)
        .where(eq(subscriptionBillingCycles.id, billingCycleId))
        .limit(1);
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
      if (ciclo?.isPaid !== true) {
        await t
          .update(subscriptionBillingCycles)
          .set({ amountDue: cuota.toFixed(2), updatedAt: new Date() })
          .where(eq(subscriptionBillingCycles.id, billingCycleId));
      }

      await t
        .insert(subscriptionMonthSchedules)
        .values(scheduleIds.map((id) => ({ billingCycleId, activityScheduleId: id })));

      let anotadas = 0;
      const sinLugar: string[] = [];
      const futuras = delMes
        .filter((c) => new Date(c.starts_at_utc).getTime() > ahora.getTime())
        .sort((a, b) => new Date(a.starts_at_utc).getTime() - new Date(b.starts_at_utc).getTime());

      for (const clase of futuras) {
        const inicio = new Date(clase.starts_at_utc);
        const scheduleId = clase.occurrence_id.slice("activity-".length, "activity-".length + 36);

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

        // Cupo del horario, con la fila bloqueada: lo que se cuenta no cambia hasta el commit.
        const filas = (await t.execute(
          sql`SELECT capacity FROM activity_schedules WHERE id = ${scheduleId} FOR UPDATE`,
        )) as unknown as { capacity: number | null }[];
        const capacidad = filas[0]?.capacity ?? null;
        if (capacidad !== null) {
          const [fila] = (await t.execute(sql`
            SELECT COUNT(*)::int AS n FROM appointments
            WHERE activity_id = ${activityId}
              AND appointment_start = ${inicio.toISOString()}::timestamptz
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
    // Carrera con otra anotación de la misma clienta: los índices únicos la frenan.
    if (esUnique(err)) {
      throw conflict("Ya está anotada: otra operación se cruzó, volvé a intentar");
    }
    throw err;
  }
}
