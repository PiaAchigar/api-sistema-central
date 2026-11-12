import { afterAll, afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { contacts } from "../db/schema";
import type { Db } from "../db/client";
import { resolverContactoWhatsApp } from "./contact-resolver.repo";

const pg = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pg, { schema }) as unknown as Db;

const QA = "ZZ_QA_RES_";
// Número de prueba: 549 + 10 dígitos que no usa nadie real.
const FROM = "5491100099001";

async function limpiar() {
  // Primero los a cargo (FK lógica a titular), después todo lo demás.
  await pg`UPDATE contacts SET holder_contact_id = NULL, relationship = NULL, relationship_other = NULL WHERE name LIKE ${QA + "%"}`;
  await pg`DELETE FROM contacts WHERE name LIKE ${QA + "%"} OR phone = ${FROM} OR whatsapp_id = ${FROM}`;
}

async function crear(v: Partial<typeof contacts.$inferInsert> & { name: string }) {
  const [r] = await db.insert(contacts).values({ isArchived: false, ...v }).returning();
  return r!;
}
const leer = async (id: string) => (await db.select().from(contacts).where(eq(contacts.id, id)))[0]!;

afterEach(limpiar);
afterAll(async () => {
  await limpiar();
  await pg.end();
});

describe("resolverContactoWhatsApp", () => {
  it("sin candidatos crea la ficha con whatsappId = phone = from", async () => {
    const r = await resolverContactoWhatsApp(db, FROM);
    expect(r.needsReview).toBe(false);
    expect(r.contact.whatsappId).toBe(FROM);
    expect(r.contact.phone).toBe(FROM);
  });

  it("uno por phone con formato distinto: lo devuelve y le guarda whatsapp_id", async () => {
    const a = await crear({ name: `${QA}a`, phone: "00 54 9 11 0009-9001" });
    const r = await resolverContactoWhatsApp(db, FROM);
    expect(r.contact.id).toBe(a.id);
    expect(r.needsReview).toBe(false);
    expect((await leer(a.id)).whatsappId).toBe(FROM);
  });

  it("uno por whatsapp_id exacto", async () => {
    const a = await crear({ name: `${QA}a`, whatsappId: FROM });
    const r = await resolverContactoWhatsApp(db, FROM);
    expect(r.contact.id).toBe(a.id);
  });

  it("un archivado no cuenta: crea uno nuevo", async () => {
    const a = await crear({ name: `${QA}a`, phone: FROM, isArchived: true });
    const r = await resolverContactoWhatsApp(db, FROM);
    expect(r.contact.id).not.toBe(a.id);
    await pg`DELETE FROM contacts WHERE id = ${r.contact.id}`;
  });

  it("dos con el mismo teléfono y sin titular: el más antiguo, por revisar, nadie recibe whatsapp_id", async () => {
    const vieja = await crear({ name: `${QA}vieja`, phone: FROM, createdAt: new Date("2020-01-01") });
    const nueva = await crear({ name: `${QA}nueva`, phone: "11 0009 9001" });
    const r = await resolverContactoWhatsApp(db, FROM);
    expect(r.contact.id).toBe(vieja.id);
    expect(r.needsReview).toBe(true);
    expect((await leer(vieja.id)).whatsappId).toBeNull();
    expect((await leer(nueva.id)).whatsappId).toBeNull();
  });

  it("compartido sin titular única: va a la más antigua que no está a cargo de otra", async () => {
    const x = await crear({ name: `${QA}x`, phone: FROM, createdAt: new Date("2021-01-01") });
    const y = await crear({ name: `${QA}y`, phone: FROM, createdAt: new Date("2020-01-01") });
    const z = await crear({ name: `${QA}z`, phone: FROM, createdAt: new Date("2022-01-01") });
    await pg`UPDATE contacts SET holder_contact_id = ${x.id}, relationship = 'hijo' WHERE id = ${y.id}`;
    const r = await resolverContactoWhatsApp(db, FROM);
    expect(r.needsReview).toBe(true);
    expect(r.contact.id).toBe(x.id);
    expect(r.contact.id).not.toBe(y.id);
    expect(z.id).not.toBe(r.contact.id);
  });

  it("si todas están a cargo de alguien, cae en la más antigua", async () => {
    const x = await crear({ name: `${QA}x`, phone: "1122223333", createdAt: new Date("2019-01-01") });
    const y = await crear({ name: `${QA}y`, phone: FROM, createdAt: new Date("2020-01-01") });
    const z = await crear({ name: `${QA}z`, phone: FROM, createdAt: new Date("2022-01-01") });
    await pg`UPDATE contacts SET holder_contact_id = ${x.id}, relationship = 'hijo' WHERE id IN (${y.id}, ${z.id})`;
    const r = await resolverContactoWhatsApp(db, FROM);
    expect(r.needsReview).toBe(true);
    expect(r.contact.id).toBe(y.id);
  });

  it("dos con titular: devuelve la titular, no marca revisión y le guarda whatsapp_id", async () => {
    const hija = await crear({ name: `${QA}hija`, phone: FROM, createdAt: new Date("2020-01-01") });
    const madre = await crear({ name: `${QA}madre`, phone: FROM });
    await pg`UPDATE contacts SET holder_contact_id = ${madre.id}, relationship = 'hija' WHERE id = ${hija.id}`;
    const r = await resolverContactoWhatsApp(db, FROM);
    expect(r.contact.id).toBe(madre.id);
    expect(r.needsReview).toBe(false);
    expect((await leer(madre.id)).whatsappId).toBe(FROM);
    expect((await leer(hija.id)).whatsappId).toBeNull();
  });

  it("un número ya resuelto (whatsapp_id exacto en la titular) no vuelve a marcar revisión", async () => {
    const hija = await crear({ name: `${QA}hija`, phone: FROM });
    const madre = await crear({ name: `${QA}madre`, phone: FROM, whatsappId: FROM });
    await pg`UPDATE contacts SET holder_contact_id = ${madre.id}, relationship = 'hija' WHERE id = ${hija.id}`;
    const r = await resolverContactoWhatsApp(db, FROM);
    expect(r.contact.id).toBe(madre.id);
    expect(r.needsReview).toBe(false);
  });

  it("teléfono corto o basura no matchea con nada", async () => {
    const basura = await crear({ name: `${QA}basura`, phone: "111111" });
    const sinTel = await crear({ name: `${QA}sintel` });
    const r = await resolverContactoWhatsApp(db, FROM);
    expect(r.contact.id).not.toBe(basura.id);
    expect(r.contact.id).not.toBe(sinTel.id);
    await pg`DELETE FROM contacts WHERE id = ${r.contact.id}`;
  });
});
