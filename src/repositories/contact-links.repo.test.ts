import { afterAll, afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { contacts } from "../db/schema";
import type { Db } from "../db/client";
import { getVinculos, setTitular } from "./contact-links.repo";

const pg = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pg, { schema }) as unknown as Db;
const QA = "ZZ_QA_VINC_";
const TEL = "1100088001";

async function limpiar() {
  await pg`UPDATE contacts SET holder_contact_id = NULL, relationship = NULL, relationship_other = NULL WHERE name LIKE ${QA + "%"}`;
  await pg`DELETE FROM contacts WHERE name LIKE ${QA + "%"}`;
}
async function crear(nombre: string, phone: string | null = TEL) {
  const [r] = await db.insert(contacts).values({ name: QA + nombre, phone, isArchived: false }).returning();
  return r!.id;
}
const status = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as { status?: number } | null;

afterEach(limpiar);
afterAll(async () => {
  await limpiar();
  await pg.end();
});

describe("vínculos titular / a cargo", () => {
  it("vincular B a A como hija: A la ve a cargo y B ve a A como titular", async () => {
    const a = await crear("A");
    const b = await crear("B");
    await setTitular(db, b, { holderContactId: a, relationship: "hija" });
    const va = await getVinculos(db, a);
    expect(va.aCargo.map((p) => p.id)).toEqual([b]);
    expect(va.aCargo[0]!.relationship).toBe("hija");
    const vb = await getVinculos(db, b);
    expect(vb.titular?.id).toBe(a);
    expect(vb.titular?.relationship).toBe("hija");
  });

  it("no puede ser titular de sí misma (400)", async () => {
    const a = await crear("A");
    const e = await status(setTitular(db, a, { holderContactId: a, relationship: "hija" }));
    expect(e?.status).toBe(400);
  });

  it("vincular a C bajo B cuando B está a cargo de A (400)", async () => {
    const a = await crear("A");
    const b = await crear("B");
    const c = await crear("C");
    await setTitular(db, b, { holderContactId: a, relationship: "pareja" });
    const e = await status(setTitular(db, c, { holderContactId: b, relationship: "hijo" }));
    expect(e?.status).toBe(400);
  });

  it("vincular a A, que tiene a cargo, bajo otro (400)", async () => {
    const a = await crear("A");
    const b = await crear("B");
    const c = await crear("C");
    await setTitular(db, b, { holderContactId: a, relationship: "hija" });
    const e = await status(setTitular(db, a, { holderContactId: c, relationship: "pareja" }));
    expect(e?.status).toBe(400);
  });

  it("'otro' sin aclarar cuál (400); con aclaración, se guarda", async () => {
    const a = await crear("A");
    const b = await crear("B");
    expect((await status(setTitular(db, b, { holderContactId: a, relationship: "otro" })))?.status).toBe(400);
    await setTitular(db, b, { holderContactId: a, relationship: "otro", relationshipOther: "vecina" });
    expect((await getVinculos(db, b)).titular?.relationshipOther).toBe("vecina");
  });

  it("holderContactId null desvincula", async () => {
    const a = await crear("A");
    const b = await crear("B");
    await setTitular(db, b, { holderContactId: a, relationship: "hija" });
    await setTitular(db, b, { holderContactId: null });
    expect((await getVinculos(db, b)).titular).toBeNull();
    expect((await getVinculos(db, a)).aCargo).toEqual([]);
  });

  it("compartenNumero lista los de la misma clave no vinculados", async () => {
    const a = await crear("A", "11 0008-8001");
    const b = await crear("B", "+54 9 11 0008 8001");
    const c = await crear("C", TEL);
    const otra = await crear("Otra", "1100088999");
    const sin = await crear("Sin", null);
    let v = await getVinculos(db, a);
    expect(v.compartenNumero.map((p) => p.id).sort()).toEqual([b, c].sort());
    await setTitular(db, b, { holderContactId: a, relationship: "hija" });
    v = await getVinculos(db, a);
    expect(v.compartenNumero.map((p) => p.id)).toEqual([c]);
    expect([otra, sin]).not.toContain(c);
  });

  it("un teléfono corto no comparte con nadie", async () => {
    const a = await crear("A", "111111");
    await crear("B", "111111");
    expect((await getVinculos(db, a)).compartenNumero).toEqual([]);
  });
});
