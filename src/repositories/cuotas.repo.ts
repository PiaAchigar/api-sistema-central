import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { badRequest, notFound } from "../lib/errors";
import { payments, subscriptionBillingCycles, trainingSubscriptions } from "../db/schema";

type Tx = Pick<Db, "select" | "insert" | "update" | "execute">;

/**
 * La cuota de un mes de una suscripción a una actividad.
 *
 * Regla de Debe (decisión de Pia, 2026-10-20):
 *  - ciclo con `is_paid = true` → Debe 0. Los pagos viejos NO están vinculados
 *    al ciclo (`payments.subscription_billing_cycle_id` nace en 1.59.0), así que
 *    el flag es la verdad histórica y no se puede deducir de los pagos.
 *  - si no: `amount_due − Σ pagos confirmados vinculados al ciclo`.
 * `pagado` es siempre la suma de los pagos vinculados.
 */
export type CuotaDelMes = {
  billingCycleId: string | null;
  /** YYYY-MM */
  mes: string;
  cuota: number;
  pagado: number;
  debe: number;
  isPaid: boolean;
};

/**
 * La MISMA regla de Debe, como fragmento SQL para consultas que resuelven
 * muchas cuotas de una (la grilla de clases). `ciclo` y `suscripcion` son los
 * alias de `subscription_billing_cycles` y de `training_subscriptions` (con
 * `monthly_amount`). NULL si no hay ciclo. Si cambia la regla de arriba,
 * cambia también acá.
 */
export function debeDeCicloSql(ciclo: string, suscripcion: string) {
  const c = sql.raw(ciclo);
  const s = sql.raw(suscripcion);
  return sql`(CASE
    WHEN ${c}.id IS NULL THEN NULL
    WHEN ${c}.is_paid = true THEN 0
    ELSE GREATEST(0, ROUND((
      COALESCE(${c}.amount_due, ${s}.monthly_amount, 0)
      - COALESCE((SELECT SUM(p.amount) FROM payments p
                  WHERE p.subscription_billing_cycle_id = ${c}.id AND p.status = 'confirmed'), 0)
    )::numeric, 2))
  END)::float8`;
}

const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Plata con 2 decimales: evita que 0.1 + 0.2 deje un Debe de 0.30000000000000004. */
const redondear = (n: number) => Math.round(n * 100) / 100;

function partesDelMes(mes: string): { anio: number; mes: number } {
  const m = MES_RE.exec(mes);
  if (!m) throw badRequest("El mes debe tener el formato YYYY-MM");
  return { anio: Number(m[1]), mes: Number(m[2]) };
}

/** "$X" del mensaje de error: sin decimales si es entero. */
export function formatearMonto(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function mensajeMontoSuperaDebe(debe: number): string {
  return `No se puede cobrar: el monto supera lo que debe ($${formatearMonto(debe)})`;
}

async function pagadoDelCiclo(tx: Tx, billingCycleId: string): Promise<number> {
  const [r] = await tx
    .select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)` })
    .from(payments)
    .where(
      and(eq(payments.subscriptionBillingCycleId, billingCycleId), eq(payments.status, "confirmed")),
    );
  return redondear(Number(r?.total ?? 0));
}

/** Cuota/pagado/Debe de un ciclo que ya existe (sin mirar el mes). */
export async function getCuotaDeCiclo(
  tx: Tx,
  billingCycleId: string,
): Promise<Omit<CuotaDelMes, "mes"> | null> {
  const [c] = await tx
    .select({
      isPaid: subscriptionBillingCycles.isPaid,
      amountDue: subscriptionBillingCycles.amountDue,
      monthlyAmount: trainingSubscriptions.monthlyAmount,
    })
    .from(subscriptionBillingCycles)
    .leftJoin(
      trainingSubscriptions,
      eq(subscriptionBillingCycles.trainingSubscriptionId, trainingSubscriptions.id),
    )
    .where(eq(subscriptionBillingCycles.id, billingCycleId))
    .limit(1);
  if (!c) return null;
  const cuota = redondear(Number(c.amountDue ?? c.monthlyAmount ?? 0));
  const pagado = await pagadoDelCiclo(tx, billingCycleId);
  const isPaid = c.isPaid === true;
  return {
    billingCycleId,
    cuota,
    pagado,
    debe: isPaid ? 0 : Math.max(0, redondear(cuota - pagado)),
    isPaid,
  };
}

export async function getCuotaDelMes(
  db: Tx,
  subscriptionId: string,
  mes: string,
): Promise<CuotaDelMes> {
  partesDelMes(mes);
  const [sub] = await db
    .select({ monthlyAmount: trainingSubscriptions.monthlyAmount })
    .from(trainingSubscriptions)
    .where(eq(trainingSubscriptions.id, subscriptionId))
    .limit(1);
  if (!sub) throw notFound("Subscription");

  const [ciclo] = await db
    .select({ id: subscriptionBillingCycles.id })
    .from(subscriptionBillingCycles)
    .where(
      and(
        eq(subscriptionBillingCycles.trainingSubscriptionId, subscriptionId),
        eq(subscriptionBillingCycles.billingMonth, mes),
      ),
    )
    .limit(1);

  if (!ciclo) {
    const cuota = redondear(Number(sub.monthlyAmount ?? 0));
    return { billingCycleId: null, mes, cuota, pagado: 0, debe: cuota, isPaid: false };
  }
  const c = await getCuotaDeCiclo(db, ciclo.id);
  return { ...c!, mes };
}

/**
 * Devuelve el ciclo del mes, creándolo si no existe. El período es el mes
 * calendario completo y `amount_due` arranca en el `monthly_amount`.
 *
 * Idempotente y a prueba de carrera: el índice único parcial
 * (training_subscription_id, billing_month) de la 1.22.1 resuelve el conflicto.
 */
export async function asegurarCicloDelMes(
  tx: Tx,
  subscriptionId: string,
  mes: string,
): Promise<string> {
  const { anio, mes: m } = partesDelMes(mes);
  const [sub] = await tx
    .select({ monthlyAmount: trainingSubscriptions.monthlyAmount })
    .from(trainingSubscriptions)
    .where(eq(trainingSubscriptions.id, subscriptionId))
    .limit(1);
  if (!sub) throw notFound("Subscription");

  // Día 0 del mes siguiente = último día de este mes.
  const ultimoDia = new Date(Date.UTC(anio, m, 0)).getUTCDate();
  await tx
    .insert(subscriptionBillingCycles)
    .values({
      trainingSubscriptionId: subscriptionId,
      billingMonth: mes,
      billingPeriodStart: `${mes}-01`,
      billingPeriodEnd: `${mes}-${String(ultimoDia).padStart(2, "0")}`,
      amountDue: String(sub.monthlyAmount ?? "0"),
      isPaid: false,
    })
    .onConflictDoNothing({
      target: [
        subscriptionBillingCycles.trainingSubscriptionId,
        subscriptionBillingCycles.billingMonth,
      ],
      // Debe coincidir con el WHERE del índice parcial para que Postgres lo elija.
      where: sql`${subscriptionBillingCycles.trainingSubscriptionId} IS NOT NULL`,
    });

  const [ciclo] = await tx
    .select({ id: subscriptionBillingCycles.id })
    .from(subscriptionBillingCycles)
    .where(
      and(
        eq(subscriptionBillingCycles.trainingSubscriptionId, subscriptionId),
        eq(subscriptionBillingCycles.billingMonth, mes),
      ),
    )
    .limit(1);
  return ciclo!.id;
}

/**
 * Bloquea la fila del ciclo hasta el fin de la transacción. Dos cobros
 * simultáneos del mismo mes se serializan acá, así que el segundo ve el Debe
 * ya descontado por el primero y no se puede cobrar de más.
 */
export async function bloquearCiclo(tx: Tx, billingCycleId: string): Promise<void> {
  await tx.execute(
    sql`SELECT id FROM subscription_billing_cycles WHERE id = ${billingCycleId} FOR UPDATE`,
  );
}

/**
 * Recalcula el Debe del ciclo dentro de la transacción del cobro y, si quedó
 * saldado (≤ 0), lo marca pagado: `is_paid`, `payment_date`, `amount_paid`
 * (suma de lo cobrado) y `payment_method` (el del último pago).
 *
 * Un ciclo que ya estaba `is_paid` no se toca: su `payment_date` histórico
 * (o el que cargó el admin a mano) es la verdad.
 */
export async function marcarMesSiCorresponde(tx: Tx, billingCycleId: string): Promise<void> {
  const [c] = await tx
    .select({
      isPaid: subscriptionBillingCycles.isPaid,
      amountDue: subscriptionBillingCycles.amountDue,
      monthlyAmount: trainingSubscriptions.monthlyAmount,
    })
    .from(subscriptionBillingCycles)
    .leftJoin(
      trainingSubscriptions,
      eq(subscriptionBillingCycles.trainingSubscriptionId, trainingSubscriptions.id),
    )
    .where(eq(subscriptionBillingCycles.id, billingCycleId))
    .limit(1);
  if (!c || c.isPaid === true) return;

  const cuota = redondear(Number(c.amountDue ?? c.monthlyAmount ?? 0));
  const pagado = await pagadoDelCiclo(tx, billingCycleId);
  if (redondear(cuota - pagado) > 0) return;

  const [ultimo] = await tx
    .select({ method: payments.paymentMethod })
    .from(payments)
    .where(
      and(eq(payments.subscriptionBillingCycleId, billingCycleId), eq(payments.status, "confirmed")),
    )
    .orderBy(desc(payments.paymentDate), desc(payments.createdAt))
    .limit(1);

  const ahora = new Date();
  await tx
    .update(subscriptionBillingCycles)
    .set({
      isPaid: true,
      paymentDate: ahora,
      amountPaid: pagado.toFixed(2),
      paymentMethod: ultimo?.method ?? null,
      updatedAt: ahora,
    })
    .where(eq(subscriptionBillingCycles.id, billingCycleId));
}
