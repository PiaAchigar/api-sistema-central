import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { contacts, conversations, messages } from "../db/schema";
import type { Db } from "../db/client";
import { recibirContactoWeb } from "./contacto-web.service";
import { getConversationWithMessages } from "../repositories/conversations.repo";

// El formulario de Contacto de la web (pedido de Pia, 2026-10-28): hasta hoy
// hacía console.log y las consultas se perdían. Ahora entran al Inbox del CRM
// como una conversación del canal "web".
const URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pg = postgres(URL, { max: 2, fetch_types: false, prepare: false });
const db = drizzle(pg, { schema }) as unknown as Db;

const QA = "ZZ_QA_CONTACTO_WEB";

async function limpiar() {
  const cs = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  const ids = cs.map((c) => c.id);
  if (ids.length === 0) return;
  const convs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(inArray(conversations.contactId, ids));
  if (convs.length > 0)
    await db.delete(messages).where(
      inArray(
        messages.conversationId,
        convs.map((c) => c.id),
      ),
    );
  await db.delete(conversations).where(inArray(conversations.contactId, ids));
  await db.delete(contacts).where(inArray(contacts.id, ids));
}

beforeEach(limpiar);
afterAll(async () => {
  await limpiar();
  await pg.end();
});

const consulta = (cambios: Partial<Parameters<typeof recibirContactoWeb>[1]> = {}) => ({
  nombre: `${QA} Ana`,
  email: "zz.qa.contacto@ejemplo.com",
  telefono: "+54 9 11 5555-0001",
  mensaje: "Hola, quiero saber el precio de la limpieza facial",
  ...cambios,
});

async function mensajesDe(conversationId: string) {
  return db.select().from(messages).where(eq(messages.conversationId, conversationId));
}

describe("recibirContactoWeb", () => {
  it("la conversación trae el teléfono y el mail, para responderle desde el CRM", async () => {
    const r = await recibirContactoWeb(db, consulta());
    expect((await getConversationWithMessages(db, r.conversationId))?.conversation).toMatchObject({
      channel: "web",
      contactPhone: "+54 9 11 5555-0001",
      contactEmail: "zz.qa.contacto@ejemplo.com",
    });
  });

  it("una persona nueva: crea el contacto y una conversación del canal web con su mensaje", async () => {
    const r = await recibirContactoWeb(db, consulta());

    const [ct] = await db.select().from(contacts).where(eq(contacts.id, r.contactId));
    expect(ct).toMatchObject({
      name: `${QA} Ana`,
      email: "zz.qa.contacto@ejemplo.com",
      phone: "+54 9 11 5555-0001",
      status: "prospect",
    });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, r.conversationId));
    expect(conv).toMatchObject({ channel: "web", status: "open", messageCount: 1 });
    const msgs = await mensajesDe(r.conversationId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      senderType: "contact",
      content: "Hola, quiero saber el precio de la limpieza facial",
    });
  });

  it("si ya existe por teléfono, aunque esté escrito distinto, no la duplica", async () => {
    const [ya] = await db
      .insert(contacts)
      .values({ name: `${QA} Ana Existente`, phone: "5491155550001", whatsappId: "5491155550001" })
      .returning();
    const r = await recibirContactoWeb(db, consulta({ email: "otro.mail@ejemplo.com" }));
    expect(r.contactId).toBe(ya!.id);
  });

  it("si ya existe por mail, sin importar mayúsculas, no la duplica", async () => {
    const [ya] = await db
      .insert(contacts)
      .values({ name: `${QA} Ana Mail`, email: "ZZ.QA.Contacto@Ejemplo.com" })
      .returning();
    const r = await recibirContactoWeb(db, consulta({ telefono: "1144440000" }));
    expect(r.contactId).toBe(ya!.id);
  });

  it("a un contacto que ya existe le completa el mail o el teléfono que le faltaban, sin pisar su nombre", async () => {
    const [ya] = await db.insert(contacts).values({ name: `${QA} Ana Original`, phone: "1155550001" }).returning();
    await recibirContactoWeb(db, consulta());
    const [ct] = await db.select().from(contacts).where(eq(contacts.id, ya!.id));
    expect(ct).toMatchObject({ name: `${QA} Ana Original`, email: "zz.qa.contacto@ejemplo.com" });
  });

  it("una segunda consulta de la misma persona va a la misma conversación", async () => {
    const a = await recibirContactoWeb(db, consulta());
    const b = await recibirContactoWeb(
      db,
      consulta({ mensaje: "Y otra cosa: ¿atienden los sábados?" }),
    );
    expect(b.conversationId).toBe(a.conversationId);
    expect(await mensajesDe(a.conversationId)).toHaveLength(2);
  });

  it("el mismo mensaje dos veces seguidas (doble clic, reenvío) se guarda una sola vez", async () => {
    const a = await recibirContactoWeb(db, consulta());
    const b = await recibirContactoWeb(db, consulta());
    expect(b.duplicado).toBe(true);
    expect(await mensajesDe(a.conversationId)).toHaveLength(1);
  });
});
