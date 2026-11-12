import { afterAll, afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import type { Db } from "../db/client";
import { resolverConversacion } from "./contact-links.repo";
import { getConversationWithMessages, listConversations } from "./conversations.repo";

const pg = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pg, { schema }) as unknown as Db;
const QA = "ZZ_QA_RESCONV_";
const LIKE = "ZZ\\_QA\\_RESCONV\\_%";
const TEL = "1144490001";

async function limpiar() {
  const ids = pg`SELECT id FROM contacts WHERE name LIKE ${LIKE}`;
  await pg`DELETE FROM delivery_logs WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id IN (${ids}))`;
  await pg`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id IN (${ids}))`;
  await pg`DELETE FROM conversations WHERE contact_id IN (${ids})`;
  await pg`UPDATE contacts SET holder_contact_id = NULL, relationship = NULL, relationship_other = NULL WHERE name LIKE ${LIKE}`;
  await pg`DELETE FROM contacts WHERE name LIKE ${LIKE}`;
}
afterEach(limpiar);
afterAll(async () => {
  await limpiar();
  await pg.end();
});

async function contacto(n: string, phone: string | null = TEL) {
  const [r] = await pg<{ id: string }[]>`
    INSERT INTO contacts (id, name, phone, is_archived) VALUES (gen_random_uuid(), ${QA + n}, ${phone}, false) RETURNING id`;
  return r!.id;
}
async function conv(contactId: string, msgs: string[], review = false) {
  const [r] = await pg<{ id: string }[]>`
    INSERT INTO conversations (id, contact_id, channel, status, message_count, needs_contact_review)
    VALUES (gen_random_uuid(), ${contactId}, 'whatsapp', 'open', ${msgs.length}, ${review}) RETURNING id`;
  for (const m of msgs) {
    await pg`INSERT INTO messages (id, conversation_id, sender_type, content, created_at) VALUES (gen_random_uuid(), ${r!.id}, 'contact', ${m}, now())`;
  }
  return r!.id;
}
const status = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as { status?: number } | null;

describe("resolver conversación por revisar", () => {
  it("pasa la conversación a la titular Y, Y recibe whatsapp_id y X queda a cargo", async () => {
    const x = await contacto("X");
    const y = await contacto("Y");
    const c = await conv(x, ["hola"], true);
    const r = await resolverConversacion(db, c, {
      titularId: y,
      otros: [{ contactId: x, relationship: "hija" }],
    });
    expect(r.conversationId).toBe(c);
    const [cv] = await pg`SELECT contact_id, needs_contact_review FROM conversations WHERE id = ${c}`;
    expect(cv!.contact_id).toBe(y);
    expect(cv!.needs_contact_review).toBe(false);
    const [cy] = await pg`SELECT whatsapp_id FROM contacts WHERE id = ${y}`;
    expect(cy!.whatsapp_id).toBe("5491144490001");
    const [cx] = await pg`SELECT holder_contact_id, relationship FROM contacts WHERE id = ${x}`;
    expect(cx!.holder_contact_id).toBe(y);
    expect(cx!.relationship).toBe("hija");
  });

  it("si Y ya tenía conversación de whatsapp, fusiona mensajes y devuelve la de Y", async () => {
    const x = await contacto("X");
    const y = await contacto("Y");
    const cx = await conv(x, ["x1", "x2"], true);
    const cy = await conv(y, ["y1"]);
    const r = await resolverConversacion(db, cx, { titularId: y, otros: [{ contactId: x, relationship: "pareja" }] });
    expect(r.conversationId).toBe(cy);
    expect((await pg`SELECT 1 FROM conversations WHERE id = ${cx}`)).toHaveLength(0);
    const m = await pg`SELECT content FROM messages WHERE conversation_id = ${cy} ORDER BY content`;
    expect(m.map((q) => q.content)).toEqual(["x1", "x2", "y1"]);
    const [c] = await pg`SELECT message_count, needs_contact_review FROM conversations WHERE id = ${cy}`;
    expect(c!.message_count).toBe(3);
    expect(c!.needs_contact_review).toBe(false);
  });

  it("titular que no comparte número: 400 y nada cambia", async () => {
    const x = await contacto("X");
    const z = await contacto("Z", "1177770000");
    const c = await conv(x, ["hola"], true);
    expect((await status(resolverConversacion(db, c, { titularId: z, otros: [] })))?.status).toBe(400);
    const [cv] = await pg`SELECT contact_id, needs_contact_review FROM conversations WHERE id = ${c}`;
    expect(cv!.contact_id).toBe(x);
    expect(cv!.needs_contact_review).toBe(true);
  });

  it("si un vínculo falla, se deshace todo (una transacción)", async () => {
    const x = await contacto("X");
    const y = await contacto("Y");
    const c = await conv(x, ["hola"], true);
    const e = await status(
      resolverConversacion(db, c, { titularId: y, otros: [{ contactId: x, relationship: "otro" }] }),
    );
    expect(e?.status).toBe(400); // 'otro' sin aclarar
    const [cv] = await pg`SELECT contact_id FROM conversations WHERE id = ${c}`;
    expect(cv!.contact_id).toBe(x);
    expect((await pg`SELECT whatsapp_id FROM contacts WHERE id = ${y}`)[0]!.whatsapp_id).toBeNull();
  });

  it("conversación inexistente: 404; la propia titular X: sólo apaga la marca", async () => {
    expect((await status(resolverConversacion(db, crypto.randomUUID(), { titularId: crypto.randomUUID(), otros: [] })))?.status).toBe(404);
    const x = await contacto("X");
    const c = await conv(x, ["hola"], true);
    const r = await resolverConversacion(db, c, { titularId: x, otros: [] });
    expect(r.conversationId).toBe(c);
    expect((await pg`SELECT needs_contact_review FROM conversations WHERE id = ${c}`)[0]!.needs_contact_review).toBe(false);
  });

  it("listConversations y el detalle devuelven needsContactReview", async () => {
    const x = await contacto("X");
    const c = await conv(x, ["hola"], true);
    const lista = await listConversations(db, { q: QA });
    expect(lista.find((i) => i.id === c)?.needsContactReview).toBe(true);
    expect((await getConversationWithMessages(db, c))?.conversation.needsContactReview).toBe(true);
  });

  it("la ficha actual X fuera de otros: 400 y nada cambia (evita el bucle del webhook)", async () => {
    const x = await contacto("X");
    const y = await contacto("Y");
    const c = await conv(x, ["hola"], true);
    expect((await status(resolverConversacion(db, c, { titularId: y, otros: [] })))?.status).toBe(400);
    expect((await pg`SELECT contact_id FROM conversations WHERE id = ${c}`)[0]!.contact_id).toBe(x);
  });

  it("un tercero que comparte el número y no está en otros: 400; si está, pasa", async () => {
    const x = await contacto("X");
    const y = await contacto("Y");
    const z = await contacto("Z");
    const c = await conv(x, ["hola"], true);
    const o = (id: string) => ({ contactId: id, relationship: "hija" as const });
    expect((await status(resolverConversacion(db, c, { titularId: y, otros: [o(x)] })))?.status).toBe(400);
    await resolverConversacion(db, c, { titularId: y, otros: [o(x), o(z)] });
    expect((await pg`SELECT holder_contact_id FROM contacts WHERE id = ${z}`)[0]!.holder_contact_id).toBe(y);
  });
});
