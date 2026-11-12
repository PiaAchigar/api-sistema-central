import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
// @ts-ignore -- el proyecto no incluye @types/node; vitest corre en Node
import { execSync } from "node:child_process";
// @ts-ignore -- idem
import { randomUUID } from "node:crypto";

/** Migración 1.70.0: rate_limit_buckets.user_id deja de apuntar a public.users.
 *  El user_id es el `sub` del JWT de Supabase (auth.users), que no está en
 *  public.users — con la FK, todo envío manual desde el Inbox daba 500. */
const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const sql = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const ARCHIVO = "src/db/migrations/1.70.0/01-rate-limit-sin-fk-users.sql";
const USUARIO_DE_AUTH = randomUUID(); // no existe en public.users, como los de producción
const MINUTO = `ZZ_QA_RATE_${Date.now()}`;

function aplicarMigracion() {
  execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${ARCHIVO}"`,
    { stdio: "pipe" },
  );
}

describe("migración 1.70.0 — rate_limit_buckets sin FK a users", () => {
  beforeAll(() => aplicarMigracion());
  afterAll(async () => {
    await sql`DELETE FROM rate_limit_buckets WHERE minute_key = ${MINUTO}`;
    await sql.end();
  });

  it("acepta un usuario que no está en public.users", async () => {
    const [r] = await sql<{ count: number }[]>`
      INSERT INTO rate_limit_buckets (user_id, minute_key, count)
      VALUES (${USUARIO_DE_AUTH}, ${MINUTO}, 1) RETURNING count`;
    expect(r!.count).toBe(1);
  });

  it("no queda ninguna FK en la tabla", async () => {
    const filas = await sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'rate_limit_buckets'::regclass AND contype = 'f'`;
    expect(filas).toHaveLength(0);
  });

  it("sigue sumando por (usuario, minuto) con la PK", async () => {
    await expect(sql`
      INSERT INTO rate_limit_buckets (user_id, minute_key, count)
      VALUES (${USUARIO_DE_AUTH}, ${MINUTO}, 1)`).rejects.toThrow();
  });

  it("es idempotente", () => {
    expect(() => aplicarMigracion()).not.toThrow();
    expect(() => aplicarMigracion()).not.toThrow();
  });
});
