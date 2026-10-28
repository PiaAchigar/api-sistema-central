// api-sistema-central/src/services/contacto-web.service.ts
//
// El formulario de Contacto de la web (pedido de Pia, 2026-10-28). Hasta hoy
// hacía console.log en el navegador y le decía a la clienta "enviado": las
// consultas se perdían. Ahora entran al Inbox del CRM, al lado de las de
// WhatsApp, como una conversación del canal "web".
//
// No dispara las automatizaciones: responden por WhatsApp, y una consulta de
// la web no abrió ninguna conversación de WhatsApp a la que contestar.
import { and, desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts, messages } from "../db/schema";
import { createContact, updateContact } from "../repositories/contacts.repo";
import { addContactMessage, upsertConversation } from "../repositories/conversations.repo";

export const CANAL_WEB = "web";

export type ConsultaWeb = {
  nombre: string;
  email: string;
  telefono: string;
  mensaje: string;
};

/** Los últimos 10 dígitos: "+54 9 11 5555-0001", "5491155550001" y
 *  "1155550001" son el mismo teléfono para Laura. */
function ultimosDiez(telefono: string): string {
  return telefono.replace(/\D/g, "").slice(-10);
}

async function buscarContacto(db: Db, email: string, telefono: string) {
  const diez = ultimosDiez(telefono);
  const porTelefono =
    diez.length === 10
      ? or(
          sql`right(regexp_replace(${contacts.phone}, '\\D', '', 'g'), 10) = ${diez}`,
          sql`right(regexp_replace(${contacts.whatsappId}, '\\D', '', 'g'), 10) = ${diez}`,
        )
      : undefined;
  const porEmail = sql`lower(${contacts.email}) = ${email.toLowerCase()}`;
  // Primero el teléfono: es lo que une con la conversación de WhatsApp.
  const rows = await db
    .select()
    .from(contacts)
    .where(porTelefono ? or(porTelefono, porEmail) : porEmail)
    .orderBy(porTelefono ? sql`(${porTelefono}) DESC` : sql`1`, contacts.createdAt)
    .limit(1);
  return rows[0] ?? null;
}

export async function recibirContactoWeb(
  db: Db,
  consulta: ConsultaWeb,
): Promise<{ contactId: string; conversationId: string; duplicado: boolean }> {
  const nombre = consulta.nombre.trim();
  const email = consulta.email.trim();
  const telefono = consulta.telefono.trim();
  const mensaje = consulta.mensaje.trim();

  let contacto = await buscarContacto(db, email, telefono);
  if (!contacto) {
    contacto = await createContact(db, { name: nombre, email, phone: telefono, status: "prospect" });
  } else {
    // Se completa lo que falta; nunca se pisa lo que Laura ya cargó.
    const faltan = {
      ...(!contacto.email && { email }),
      ...(!contacto.phone && { phone: telefono }),
    };
    if (Object.keys(faltan).length > 0) await updateContact(db, contacto.id, faltan);
  }

  const conv = await upsertConversation(db, { contactId: contacto.id, channel: CANAL_WEB });

  // Doble clic o reenvío del mismo formulario: el último mensaje ya es éste.
  const [ultimo] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.conversationId, conv.id), eq(messages.senderType, "contact")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (ultimo?.content === mensaje) {
    return { contactId: contacto.id, conversationId: conv.id, duplicado: true };
  }

  await addContactMessage(db, conv.id, mensaje);
  return { contactId: contacto.id, conversationId: conv.id, duplicado: false };
}
