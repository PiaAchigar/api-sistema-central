import { afterAll, afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import type { Db } from "../db/client";
import { fksHacia, previewUnion, unirContactos } from "./contact-merge.repo";

const pg = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pg, { schema }) as unknown as Db;
// En LIKE el "_" es comodín: se escapa para que sólo matchee este prefijo.
const QA = "ZZ_QA_MERGE_";
const LIKE = "ZZ\\_QA\\_MERGE\\_%";

async function limpiar() {
  await pg`DELETE FROM delivery_logs WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${LIKE}))`;
  await pg`DELETE FROM message_queue WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${LIKE}))`;
  await pg`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${LIKE}))`;
  await pg`DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${LIKE})`;
  await pg`DELETE FROM customer_credit_movements WHERE customer_id IN (SELECT id FROM customers WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${LIKE}))`;
  await pg`DELETE FROM appointments WHERE customer_id IN (SELECT id FROM customers WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${LIKE}))`;
  await pg`DELETE FROM payments WHERE customer_id IN (SELECT id FROM customers WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${LIKE}))`;
  await pg`DELETE FROM customers WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${LIKE})`;
  await pg`DELETE FROM deals WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${LIKE})`;
  await pg`DELETE FROM contact_notes WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${LIKE})`;
  await pg`UPDATE contacts SET holder_contact_id = NULL, relationship = NULL, relationship_other = NULL WHERE name LIKE ${LIKE}`;
  await pg`DELETE FROM contacts WHERE name LIKE ${LIKE}`;
}
afterEach(limpiar);
afterAll(async () => {
  await limpiar();
  await pg.end();
});

async function contacto(nombre: string, extra: { email?: string; notes?: string; tags?: string[]; phone?: string } = {}) {
  const [r] = await pg<{ id: string }[]>`
    INSERT INTO contacts (id, name, email, notes, tags, phone, is_archived)
    VALUES (gen_random_uuid(), ${QA + nombre}, ${extra.email ?? null}, ${extra.notes ?? null},
            ${extra.tags ? `{${extra.tags.join(",")}}` : null}::text[], ${extra.phone ?? null}, false) RETURNING id`;
  return r!.id;
}
async function customer(contactId: string, o: { saldo?: number; dni?: string | null; cuit?: string | null } = {}) {
  const [r] = await pg<{ id: string }[]>`
    INSERT INTO customers (id, contact_id, credit_balance, dni, cuit)
    VALUES (gen_random_uuid(), ${contactId}, ${o.saldo ?? 0}, ${o.dni ?? null}, ${o.cuit ?? null}) RETURNING id`;
  return r!.id;
}
async function conversacion(contactId: string, channel: string, mensajes: string[]) {
  const [r] = await pg<{ id: string }[]>`
    INSERT INTO conversations (id, contact_id, channel, status, message_count)
    VALUES (gen_random_uuid(), ${contactId}, ${channel}, 'open', ${mensajes.length}) RETURNING id`;
  for (const m of mensajes) {
    await pg`INSERT INTO messages (id, conversation_id, sender_type, content) VALUES (gen_random_uuid(), ${r!.id}, 'contact', ${m})`;
  }
  return r!.id;
}
const existe = async (id: string) => (await pg`SELECT 1 FROM contacts WHERE id = ${id}`).length === 1;
const status = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as { status?: number } | null;

describe("unir dos fichas", () => {
  it("lee las FK de pg_constraint (contacts y customers)", async () => {
    const c = await fksHacia(db, "contacts");
    const nombres = c.map((f) => `${f.tabla}.${f.columna}`);
    for (const esperado of ["conversations.contact_id", "deals.contact_id", "contact_notes.contact_id",
      "customers.contact_id", "delivery_logs.contact_id", "call_logs.contact_id",
      "analytics_events.contact_id", "contacts.holder_contact_id"]) {
      expect(nombres).toContain(esperado);
    }
    const cu = (await fksHacia(db, "customers")).map((f) => f.tabla);
    for (const t of ["appointments", "payments", "invoices", "customer_purchase",
      "customer_credit_movements", "training_enrollments", "training_subscriptions"]) {
      expect(cu).toContain(t);
    }
  });

  it("B con conversación web y deal: quedan en A y B no existe", async () => {
    const a = await contacto("A");
    const b = await contacto("B");
    const conv = await conversacion(b, "web", ["hola"]);
    await pg`INSERT INTO deals (id, contact_id, stage) VALUES (gen_random_uuid(), ${b}, 'lead')`;
    await pg`INSERT INTO contact_notes (contact_id, body) VALUES (${b}, 'nota de B')`;
    await unirContactos(db, a, b);
    expect(await existe(b)).toBe(false);
    expect((await pg`SELECT contact_id FROM conversations WHERE id = ${conv}`)[0]!.contact_id).toBe(a);
    expect((await pg`SELECT count(*)::int n FROM deals WHERE contact_id = ${a}`)[0]!.n).toBe(1);
    expect((await pg`SELECT count(*)::int n FROM contact_notes WHERE contact_id = ${a}`)[0]!.n).toBe(1);
  });

  it("ambos con conversación whatsapp: una sola en A con los mensajes de las dos; no se pierden delivery_logs ni cola (CASCADE)", async () => {
    const a = await contacto("A");
    const b = await contacto("B");
    const ca = await conversacion(a, "whatsapp", ["a1", "a2"]);
    const cb = await conversacion(b, "whatsapp", ["b1"]);
    await pg`INSERT INTO delivery_logs (conversation_id, contact_id, channel, status) VALUES (${cb}, ${b}, 'whatsapp', 'success')`;
    await pg`INSERT INTO message_queue (conversation_id, content, sender_type) VALUES (${cb}, 'en cola', 'agent')`;
    await unirContactos(db, a, b);
    const convs = await pg`SELECT id, message_count FROM conversations WHERE contact_id = ${a} AND channel = 'whatsapp'`;
    expect(convs).toHaveLength(1);
    expect(convs[0]!.id).toBe(ca);
    expect(convs[0]!.message_count).toBe(3);
    const msgs = await pg`SELECT content FROM messages WHERE conversation_id = ${ca} ORDER BY content`;
    expect(msgs.map((m) => m.content)).toEqual(["a1", "a2", "b1"]);
    expect((await pg`SELECT conversation_id, contact_id FROM delivery_logs WHERE conversation_id = ${ca}`)).toHaveLength(1);
    expect((await pg`SELECT contact_id FROM delivery_logs WHERE conversation_id = ${ca}`)[0]!.contact_id).toBe(a);
    expect((await pg`SELECT 1 FROM message_queue WHERE conversation_id = ${ca}`)).toHaveLength(1);
    expect((await pg`SELECT 1 FROM conversations WHERE id = ${cb}`)).toHaveLength(0);
  });

  it("sólo B con customer y turno: customer reapuntado a A", async () => {
    const a = await contacto("A");
    const b = await contacto("B");
    const cu = await customer(b, { saldo: 70 });
    await pg`INSERT INTO appointments (id, customer_id) VALUES (gen_random_uuid(), ${cu})`;
    await unirContactos(db, a, b);
    const r = await pg`SELECT id, credit_balance FROM customers WHERE contact_id = ${a}`;
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(cu);
    expect(Number(r[0]!.credit_balance)).toBe(70);
    expect((await pg`SELECT 1 FROM appointments WHERE customer_id = ${cu}`)).toHaveLength(1);
  });

  it("ambos con customer (100 y 50): un customer con 150 y todo lo de B apunta a él", async () => {
    const a = await contacto("A");
    const b = await contacto("B");
    const ca = await customer(a, { saldo: 100 });
    const cb = await customer(b, { saldo: 50, dni: "30111222" });
    await pg`INSERT INTO appointments (id, customer_id) VALUES (gen_random_uuid(), ${ca})`;
    await pg`INSERT INTO appointments (id, customer_id) VALUES (gen_random_uuid(), ${cb})`;
    await pg`INSERT INTO payments (id, customer_id) VALUES (gen_random_uuid(), ${cb})`;
    await pg`INSERT INTO customer_credit_movements (customer_id, amount, reason) VALUES (${cb}, 50, 'ZZ_QA_MERGE_')`;
    expect(await previewUnion(db, a, b)).toMatchObject({ turnos: 1, pagos: 1, facturas: 0, compras: 0 });
    await unirContactos(db, a, b);
    const r = await pg`SELECT id, credit_balance, dni FROM customers WHERE contact_id = ${a}`;
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(ca);
    expect(Number(r[0]!.credit_balance)).toBe(150);
    expect(r[0]!.dni).toBe("30111222");
    expect((await pg`SELECT 1 FROM customers WHERE id = ${cb}`)).toHaveLength(0);
    expect((await pg`SELECT 1 FROM appointments WHERE customer_id = ${ca}`)).toHaveLength(2);
    expect((await pg`SELECT 1 FROM payments WHERE customer_id = ${ca}`)).toHaveLength(1);
    expect((await pg`SELECT 1 FROM customer_credit_movements WHERE customer_id = ${ca}`)).toHaveLength(1);
  });

  it("B titular de C: C pasa a A; A que estaba a cargo de otra queda libre", async () => {
    const h = await contacto("H");
    const a = await contacto("A");
    const b = await contacto("B");
    const c = await contacto("C");
    await pg`UPDATE contacts SET holder_contact_id = ${h}, relationship = 'pareja' WHERE id = ${a}`;
    await pg`UPDATE contacts SET holder_contact_id = ${b}, relationship = 'hija' WHERE id = ${c}`;
    await unirContactos(db, a, b);
    const [rc] = await pg`SELECT holder_contact_id, relationship FROM contacts WHERE id = ${c}`;
    expect(rc!.holder_contact_id).toBe(a);
    expect(rc!.relationship).toBe("hija");
    const [ra] = await pg`SELECT holder_contact_id, relationship FROM contacts WHERE id = ${a}`;
    expect(ra!.holder_contact_id).toBeNull();
    expect(ra!.relationship).toBeNull();
  });

  it("A a cargo de B: al unir, A no queda a cargo de sí misma", async () => {
    const a = await contacto("A");
    const b = await contacto("B");
    await pg`UPDATE contacts SET holder_contact_id = ${b}, relationship = 'hijo' WHERE id = ${a}`;
    await unirContactos(db, a, b);
    const [ra] = await pg`SELECT holder_contact_id FROM contacts WHERE id = ${a}`;
    expect(ra!.holder_contact_id).toBeNull();
  });

  it("DNI distintos con ambos cargados: 409 y nada cambió", async () => {
    const a = await contacto("A");
    const b = await contacto("B");
    await customer(a, { dni: "1111" });
    await customer(b, { dni: "2222" });
    await conversacion(b, "web", ["x"]);
    expect((await status(unirContactos(db, a, b)))?.status).toBe(409);
    expect(await existe(b)).toBe(true);
    expect((await pg`SELECT 1 FROM conversations WHERE contact_id = ${b}`)).toHaveLength(1);
  });

  it("A y B iguales: 400", async () => {
    const a = await contacto("A");
    expect((await status(unirContactos(db, a, a)))?.status).toBe(400);
  });

  it("completa vacíos de A con B sin pisar lo cargado; une tags y notas", async () => {
    const a = await contacto("A", { email: "a@x.com", notes: "nota A", tags: ["vip", "x"] });
    const b = await contacto("B", { email: "b@x.com", notes: "nota B", tags: ["x", "nuevo"], phone: "1155550000" });
    await unirContactos(db, a, b);
    const [r] = await pg`SELECT email, phone, notes, tags::text AS tags FROM contacts WHERE id = ${a}`;
    expect(r!.email).toBe("a@x.com");
    expect(r!.phone).toBe("1155550000");
    expect(r!.notes).toBe("nota A\n---\nnota B");
    expect(r!.tags).toBe("{vip,x,nuevo}");
  });

  it("previewUnion cuenta conversaciones y a cargo", async () => {
    const a = await contacto("A");
    const b = await contacto("B");
    const c = await contacto("C");
    await conversacion(b, "web", ["x"]);
    await pg`UPDATE contacts SET holder_contact_id = ${b}, relationship = 'hija' WHERE id = ${c}`;
    expect(await previewUnion(db, a, b)).toEqual({
      conversaciones: 1, turnos: 0, pagos: 0, facturas: 0, compras: 0, aCargo: 1,
    });
  });
});
