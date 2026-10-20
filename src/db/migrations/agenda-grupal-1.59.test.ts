import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
// @ts-ignore -- el proyecto no incluye @types/node (solo workers-types); vitest corre en Node
import { execSync } from "node:child_process";

/**
 * Migración 1.59.0 (agenda grupal) contra la base local. Cada test arma sus
 * propios datos (prefijo ZZ_QA_) y no depende de lo que haya en la base.
 */
const sql = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});

const QA = "ZZ_QA_AG159";
// vitest corre con cwd = api-sistema-central
const ARCHIVO = "src/db/migrations/1.59.0/01-agenda-grupal.sql";

/** Aplica el archivo completo, igual que se hace a mano. Falla si psql falla. */
function aplicarMigracion() {
  execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${ARCHIVO}"`,
    { stdio: "pipe" },
  );
}

let clienteId: string;
let actividadId: string;
let suscripcionId: string;

async function limpiar() {
  await sql`DELETE FROM payments WHERE notes LIKE ${QA + "%"}`;
  await sql`DELETE FROM appointments WHERE notes LIKE ${QA + "%"}`;
  await sql`DELETE FROM subscription_billing_cycles WHERE notes LIKE ${QA + "%"}`;
  await sql`DELETE FROM training_subscriptions WHERE notes LIKE ${QA + "%"}`;
  await sql`DELETE FROM activity_schedules WHERE activity_id IN (SELECT id FROM activities WHERE name LIKE ${QA + "%"})`;
  await sql`DELETE FROM activities WHERE name LIKE ${QA + "%"}`;
  await sql`DELETE FROM customers WHERE tax_id LIKE ${QA + "%"}`;
}

async function ciclo(mes: string, extra: { paid?: number; parcial?: number } = {}) {
  const [c] = await sql`
    INSERT INTO subscription_billing_cycles
      (id, training_subscription_id, billing_month, billing_period_start, billing_period_end, is_paid, amount_paid, notes)
    VALUES (gen_random_uuid(), ${suscripcionId}, ${mes}, ${mes + "-01"}, ${mes + "-28"},
            ${extra.paid != null}, ${extra.paid ?? extra.parcial ?? null}, ${QA})
    RETURNING id`;
  return c!.id as string;
}

async function turno(estado: string, inicio = "2030-01-10 10:00:00") {
  return sql`
    INSERT INTO appointments (id, customer_id, activity_id, appointment_start, status, notes)
    VALUES (gen_random_uuid(), ${clienteId}, ${actividadId}, ${inicio}, ${estado}, ${QA})
    RETURNING id`;
}

beforeAll(async () => {
  await limpiar();
  aplicarMigracion();
  const [cli] = await sql`INSERT INTO customers (id, tax_id) VALUES (gen_random_uuid(), ${QA}) RETURNING id`;
  clienteId = cli!.id;
  const [act] = await sql`
    INSERT INTO activities (id, name, activity_type, monthly_base_price)
    VALUES (gen_random_uuid(), ${QA}, 'class', 1000) RETURNING id`;
  actividadId = act!.id;
  const [sub] = await sql`
    INSERT INTO training_subscriptions (id, activity_id, customer_id, subscription_start_date, monthly_amount, notes)
    VALUES (gen_random_uuid(), ${actividadId}, ${clienteId}, '2030-01-01', 1000, ${QA}) RETURNING id`;
  suscripcionId = sub!.id;
});

afterAll(async () => {
  await limpiar();
  await sql.end();
});

describe("migración 1.59.0", () => {
  it("backfill: pagado -> amount_paid; impago (aun con amount_paid parcial) -> monthly_amount", async () => {
    // Ciclos "viejos" sin amount_due; se re-aplica la migración (idempotente).
    const pagado = await ciclo("2030-01", { paid: 800 });
    const parcial = await ciclo("2030-04", { parcial: 300 });
    const impago = await ciclo("2030-05");
    const sinActividad = await sql`
      INSERT INTO subscription_billing_cycles
        (id, subscription_id, billing_month, billing_period_start, billing_period_end, notes)
      VALUES (gen_random_uuid(), ${suscripcionId}, '2030-06', '2030-06-01', '2030-06-28', ${QA})
      RETURNING id`;
    aplicarMigracion();
    const due = async (id: string) =>
      (await sql`SELECT amount_due FROM subscription_billing_cycles WHERE id = ${id}`)[0]!.amount_due;
    expect(Number(await due(pagado))).toBe(800);
    expect(Number(await due(parcial))).toBe(1000); // monthly_amount: el parcial manual no cuenta
    expect(Number(await due(impago))).toBe(1000);
    // Sin training_subscription_id no es de actividades: queda NULL a propósito.
    expect(await due(sinActividad[0]!.id)).toBeNull();
  });

  it("un pago no puede ser de una compra y de una cuota a la vez", async () => {
    const cicloId = await ciclo("2030-02");
    const [compra] = await sql`SELECT id FROM customer_purchase LIMIT 1`;
    // Si no hay compras en la base, el CHECK igual se evalúa antes que las FK.
    const compraId = compra?.id ?? "00000000-0000-0000-0000-000000000001";
    await expect(
      sql`INSERT INTO payments (id, notes, customer_purchase_id, subscription_billing_cycle_id)
          VALUES (gen_random_uuid(), ${QA}, ${compraId}, ${cicloId})`,
    ).rejects.toThrow(/ck_payments_compra_o_cuota/);
  });

  it("no se puede anotar dos veces a la misma clase", async () => {
    await turno("scheduled");
    await expect(turno("scheduled")).rejects.toThrow(/ux_appt_clase_actividad/);
    await sql`UPDATE appointments SET status = 'cancelled' WHERE customer_id = ${clienteId} AND notes = ${QA}`;
    await expect(turno("scheduled")).resolves.toBeDefined();
  });

  it("subscription_month_schedules borra en cascada con el ciclo", async () => {
    const cicloId = await ciclo("2030-03");
    const [h] = await sql`
      INSERT INTO activity_schedules (id, activity_id, day_of_week, start_time, end_time)
      VALUES (gen_random_uuid(), ${actividadId}, 2, '10:00', '11:00') RETURNING id`;
    await sql`INSERT INTO subscription_month_schedules (billing_cycle_id, activity_schedule_id)
              VALUES (${cicloId}, ${h!.id})`;
    await sql`DELETE FROM subscription_billing_cycles WHERE id = ${cicloId}`;
    const filas = await sql`SELECT 1 FROM subscription_month_schedules WHERE billing_cycle_id = ${cicloId}`;
    expect(filas.length).toBe(0);
  });
});
