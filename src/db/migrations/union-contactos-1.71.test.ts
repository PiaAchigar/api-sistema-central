import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
// @ts-ignore -- el proyecto no incluye @types/node; vitest corre en Node
import { execSync } from "node:child_process";

/** Migración 1.71.0: titular, parentesco y conversación por revisar. */
const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const sql = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const ARCHIVO = "src/db/migrations/1.71.0/01-titular-y-revision.sql";
const TAG = `ZZ_QA_UNION_${Date.now()}`;

function aplicarMigracion() {
  execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${ARCHIVO}"`,
    { stdio: "pipe" },
  );
}

async function nuevoContacto(extra: { holder?: string; rel?: string } = {}) {
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO contacts (id, name, holder_contact_id, relationship)
    VALUES (gen_random_uuid(), ${TAG}, ${extra.holder ?? null}, ${extra.rel ?? null}) RETURNING id`;
  return r!.id;
}

describe("migración 1.71.0 — titular y revisión", () => {
  let titular: string;
  beforeAll(async () => {
    aplicarMigracion();
    titular = await nuevoContacto();
  });
  afterAll(async () => {
    await sql`DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE name = ${TAG})`;
    await sql`DELETE FROM contacts WHERE name = ${TAG}`;
    await sql.end();
  });

  it("acepta un contacto a cargo con parentesco válido", async () => {
    const id = await nuevoContacto({ holder: titular, rel: "hija" });
    expect(id).toBeTruthy();
  });

  it("rechaza un parentesco que no está en la lista", async () => {
    await expect(nuevoContacto({ holder: titular, rel: "prima" })).rejects.toThrow();
  });

  it("rechaza que un contacto sea titular de sí mismo", async () => {
    const id = await nuevoContacto();
    await expect(sql`UPDATE contacts SET holder_contact_id = ${id} WHERE id = ${id}`).rejects.toThrow();
  });

  it("rechaza parentesco sin titular", async () => {
    await expect(nuevoContacto({ rel: "hija" })).rejects.toThrow();
  });

  it("relationship_other existe", async () => {
    const [r] = await sql<{ c: string }[]>`
      SELECT column_name AS c FROM information_schema.columns
      WHERE table_name = 'contacts' AND column_name = 'relationship_other'`;
    expect(r?.c).toBe("relationship_other");
  });

  it("conversations.needs_contact_review arranca en false", async () => {
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO conversations (id, contact_id, channel) VALUES (gen_random_uuid(), ${titular}, 'whatsapp') RETURNING id`;
    const [r] = await sql<{ needs_contact_review: boolean }[]>`
      SELECT needs_contact_review FROM conversations WHERE id = ${c!.id}`;
    expect(r!.needs_contact_review).toBe(false);
  });

  it("crea los índices", async () => {
    const r = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'contacts'
      AND indexname IN ('ix_contacts_holder','ix_contacts_phone_clave','ix_contacts_whatsapp_id')`;
    expect(r.length).toBe(3);
  });

  it("es idempotente (3 aplicaciones)", () => {
    expect(() => aplicarMigracion()).not.toThrow();
    expect(() => aplicarMigracion()).not.toThrow();
    expect(() => aplicarMigracion()).not.toThrow();
  });
});
