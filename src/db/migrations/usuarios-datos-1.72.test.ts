import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
// @ts-ignore -- el proyecto no incluye @types/node; vitest corre en Node
import { execSync } from "node:child_process";

/**
 * Migración de datos 1.72.0/02: borra las filas viejas del seed de usuarios (lista cerrada de IDs)
 * sólo si no tienen login ni referencias, y carga full_name por e-mail en las filas con login.
 */
const sql = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const M02 = "src/db/migrations/1.72.0/02-usuarios-limpieza-y-nombres.sql";
const VIEJA_LIBRE = "cca2106d-e099-4847-ad00-21d619111c12"; // Cami
const VIEJA_USADA = "7a601e7e-c874-414c-9481-2ceb5bbfff50"; // Cande
const VIEJA_CON_LOGIN = "e78ba96c-e9bb-4790-bf46-dd43ad3142c2"; // Evan
const EMAIL = "rios.agos20@gmail.com";

function aplicar(): string {
  return execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${M02}" 2>&1`,
    { stdio: "pipe" },
  ).toString();
}
const existe = async (id: string) => (await sql`SELECT 1 FROM users WHERE id = ${id}`).length === 1;
let convId: string | null = null;
let conLoginId: string | null = null;

async function limpiar() {
  if (convId) await sql`DELETE FROM conversations WHERE id = ${convId}`;
  await sql`DELETE FROM users WHERE id IN (${VIEJA_LIBRE}, ${VIEJA_USADA}, ${VIEJA_CON_LOGIN})`;
  if (conLoginId) await sql`DELETE FROM users WHERE id = ${conLoginId}`;
}

describe("migración 1.72.0/02 — usuarios", () => {
  afterAll(async () => {
    await limpiar();
    await sql.end();
  });

  it("borra la vieja sin nada, deja la referenciada y la que tiene login, y carga nombres", async () => {
    await limpiar();
    await sql`INSERT INTO users (id, full_name, role, is_active) VALUES (${VIEJA_LIBRE}, 'Cami', 'operator', false)`;
    await sql`INSERT INTO users (id, full_name, role, is_active) VALUES (${VIEJA_USADA}, 'Cande', 'operator', false)`;
    await sql`INSERT INTO users (id, full_name, role, is_active, auth_id) VALUES (${VIEJA_CON_LOGIN}, 'Evan', 'operator', true, gen_random_uuid())`;
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO conversations (id, channel, status, assigned_agent_id)
      VALUES (gen_random_uuid(), 'web', 'open', ${VIEJA_USADA}) RETURNING id`;
    convId = c!.id;
    await sql`DELETE FROM users WHERE email = ${EMAIL}`;
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (id, email, role, is_active, auth_id)
      VALUES (gen_random_uuid(), ${EMAIL}, 'manager', true, gen_random_uuid()) RETURNING id`;
    conLoginId = u!.id;

    aplicar();

    expect(await existe(VIEJA_LIBRE)).toBe(false);
    expect(await existe(VIEJA_USADA)).toBe(true);
    expect(await existe(VIEJA_CON_LOGIN)).toBe(true);
    const [n] = await sql<{ full_name: string }[]>`SELECT full_name FROM users WHERE id = ${conLoginId}`;
    expect(n!.full_name).toBe("Agostina Ríos");
  });

  it("es idempotente", () => {
    expect(() => aplicar()).not.toThrow();
  });
});
