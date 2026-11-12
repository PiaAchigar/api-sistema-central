import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts } from "../db/schema";
import { clave } from "../lib/telefono";
import { createContact } from "./contacts.repo";

type Contact = typeof contacts.$inferSelect;

/** Misma expresión que el índice ix_contacts_phone_clave. No necesita guarda de "menos de
 *  10 dígitos": `k` siempre tiene 10, así que un teléfono corto o NULL nunca le es igual. */
const claveDe = (col: typeof contacts.phone | typeof contacts.whatsappId) =>
  sql`right(regexp_replace(${col}, '\\D', '', 'g'), 10)`;

const noArchivado = sql`${contacts.isArchived} IS NOT TRUE`;

/** La titular del conjunto: la única sin `holder_contact_id` a la que apuntan todas las demás. */
function titularDe(candidatos: Contact[]): Contact | null {
  const sinTitular = candidatos.filter((c) => !c.holderContactId);
  if (sinTitular.length !== 1) return null;
  const t = sinTitular[0]!;
  return candidatos.every((c) => c.id === t.id || c.holderContactId === t.id) ? t : null;
}

async function guardarWhatsappId(db: Db, c: Contact, from: string): Promise<Contact> {
  if (c.whatsappId) return c;
  const [r] = await db.update(contacts).set({ whatsappId: from }).where(eq(contacts.id, c.id)).returning();
  return r ?? c;
}

/** A qué ficha va un mensaje de WhatsApp entrante (spec "Webhook de WhatsApp"). */
export async function resolverContactoWhatsApp(
  db: Db,
  from: string,
): Promise<{ contact: Contact; needsReview: boolean }> {
  let candidatos = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.whatsappId, from), noArchivado))
    .orderBy(asc(contacts.createdAt), asc(contacts.id));

  if (candidatos.length === 0) {
    const k = clave(from);
    if (k) {
      candidatos = await db
        .select()
        .from(contacts)
        .where(
          and(
            noArchivado,
            sql`(${claveDe(contacts.phone)} = ${k} OR ${claveDe(contacts.whatsappId)} = ${k})`,
          ),
        )
        .orderBy(asc(contacts.createdAt), asc(contacts.id));
    }
  }

  if (candidatos.length === 0) {
    const nuevo = await createContact(db, {
      name: from,
      phone: from,
      whatsappId: from,
      status: "prospect",
    });
    return { contact: nuevo, needsReview: false };
  }

  if (candidatos.length === 1) {
    return { contact: await guardarWhatsappId(db, candidatos[0]!, from), needsReview: false };
  }

  const titular = titularDe(candidatos);
  if (titular) return { contact: await guardarWhatsappId(db, titular, from), needsReview: false };

  // Número compartido sin titular: la más antigua, y Laura elige la ficha.
  return { contact: candidatos[0]!, needsReview: true };
}
