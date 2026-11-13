import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts, conversations } from "../db/schema";
import { badRequest, conflict, notFound } from "../lib/errors";
import { aWhatsappId, clave, diagnosticoTelefono } from "../lib/telefono";
import { fusionarConversacion } from "./contact-merge.repo";

export const RELATIONSHIPS = ["pareja", "hijo", "hija", "nieto", "nieta", "otro"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

type Persona = {
  id: string;
  name: string | null;
  relationship: string | null;
  relationshipOther: string | null;
};

export type Vinculos = {
  titular: Persona | null;
  aCargo: Persona[];
  compartenNumero: { id: string; name: string | null }[];
};

const columnasPersona = {
  id: contacts.id,
  name: contacts.name,
  relationship: contacts.relationship,
  relationshipOther: contacts.relationshipOther,
};

/**
 * Fichas activas (sin la propia) que usan el mismo número: se arma la clave (últimos 10 dígitos)
 * de teléfono Y whatsapp_id del contacto y se busca en AMBAS columnas. Única regla de "comparten
 * número": la usan la lista de vínculos y el resolver, para que nunca discrepen.
 */
export async function fichasQueCompartenNumero(
  db: Db,
  contacto: { id: string; phone: string | null; whatsappId: string | null },
): Promise<{ id: string; name: string | null; holderContactId: string | null }[]> {
  const claves = [...new Set([clave(contacto.phone), clave(contacto.whatsappId)].filter((k): k is string => !!k))];
  if (claves.length === 0) return [];
  const coincide = claves.map(
    (k) =>
      sql`(right(regexp_replace(${contacts.phone}, '\\D', '', 'g'), 10) = ${k} OR right(regexp_replace(${contacts.whatsappId}, '\\D', '', 'g'), 10) = ${k})`,
  );
  return db
    .select({ id: contacts.id, name: contacts.name, holderContactId: contacts.holderContactId })
    .from(contacts)
    .where(and(sql`${contacts.isArchived} IS NOT TRUE`, ne(contacts.id, contacto.id), or(...coincide)))
    .orderBy(asc(contacts.createdAt), asc(contacts.id));
}

export async function getVinculos(db: Db, contactId: string): Promise<Vinculos> {
  const [yo] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!yo) throw notFound("Contact");

  const titular = yo.holderContactId
    ? ((
        await db
          .select(columnasPersona)
          .from(contacts)
          .where(eq(contacts.id, yo.holderContactId))
          .limit(1)
      )[0] ?? null)
    : null;
  // El parentesco vive en la ficha de la persona a cargo: el de la titular es el de ELLA con su
  // titular, no el de ella con vos. Para `titular` mostramos el parentesco de este contacto.
  const titularConParentesco = titular
    ? { ...titular, relationship: yo.relationship, relationshipOther: yo.relationshipOther }
    : null;

  const aCargo = await db
    .select(columnasPersona)
    .from(contacts)
    .where(eq(contacts.holderContactId, contactId))
    .orderBy(asc(contacts.name), asc(contacts.id));

  const vinculados = new Set<string>([
    ...(yo.holderContactId ? [yo.holderContactId] : []),
    ...aCargo.map((p) => p.id),
  ]);
  const compartenNumero = (await fichasQueCompartenNumero(db, yo))
    .filter((m) => !vinculados.has(m.id))
    .map((m) => ({ id: m.id, name: m.name }));

  return { titular: titularConParentesco, aCargo, compartenNumero };
}

const MOTIVOS = {
  con15: "sacá el 15 del número",
  con0: "sacá el 0 del principio",
  corto: "el número es muy corto",
  extranjero: "sólo se aceptan números de Argentina",
} as const;

export async function setTitular(
  db: Db,
  contactId: string,
  input: {
    holderContactId: string | null;
    relationship?: Relationship;
    relationshipOther?: string;
    /** Sólo al desvincular. string = número propio; null = "sin número por ahora"; omitido = no se toca. */
    telefonoPropio?: string | null;
  },
): Promise<void> {
  const [yo] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!yo) throw notFound("Contact");

  if (input.holderContactId === null) {
    const cambios: Partial<typeof contacts.$inferInsert> = {
      holderContactId: null,
      relationship: null,
      relationshipOther: null,
    };
    const propio = input.telefonoPropio;
    if (typeof propio === "string") {
      const wa = aWhatsappId(propio);
      if (!wa) {
        const d = diagnosticoTelefono(propio);
        throw badRequest(`WhatsApp inválido: ${d.ok ? "número no válido" : MOTIVOS[d.motivo]}`);
      }
      const otras = await fichasQueCompartenNumero(db, { id: contactId, phone: propio, whatsappId: wa });
      if (otras.length > 0) {
        throw conflict(`Ese número ya lo tiene ${otras[0]!.name ?? "otra ficha"}. Usá otro o unilas desde la ficha.`);
      }
      cambios.phone = propio.trim();
      cambios.whatsappId = wa;
    } else if (propio === null && yo.holderContactId) {
      // "Sin número por ahora": se libera sólo lo que era el número de la titular.
      const [tit] = await db.select().from(contacts).where(eq(contacts.id, yo.holderContactId)).limit(1);
      const claves = new Set([clave(tit?.phone), clave(tit?.whatsappId)].filter((k): k is string => !!k));
      if (claves.size > 0) {
        const kp = clave(yo.phone);
        const kw = clave(yo.whatsappId);
        if (kp && claves.has(kp)) cambios.phone = null;
        if (kw && claves.has(kw)) cambios.whatsappId = null;
      }
    }
    await db.update(contacts).set(cambios).where(eq(contacts.id, contactId));
    return;
  }

  const holderId = input.holderContactId;
  if (holderId === contactId) throw badRequest("Una persona no puede ser titular de sí misma");

  const [titular] = await db.select().from(contacts).where(eq(contacts.id, holderId)).limit(1);
  if (!titular) throw notFound("Contact (titular)");
  if (titular.holderContactId) {
    throw badRequest("Esa persona ya está a cargo de otra: no puede ser titular");
  }

  const [aCargo] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.holderContactId, contactId))
    .limit(1);
  if (aCargo) throw badRequest("Esta persona tiene personas a cargo: no puede quedar a cargo de otra");

  const { relationship, relationshipOther } = input;
  if (!relationship) throw badRequest("Falta el parentesco");
  const otro = relationshipOther?.trim();
  if (relationship === "otro" && !otro) throw badRequest("Con parentesco 'otro' hay que aclarar cuál");

  await db
    .update(contacts)
    .set({
      holderContactId: holderId,
      relationship,
      relationshipOther: relationship === "otro" ? otro! : null,
    })
    .where(eq(contacts.id, contactId));
}

/**
 * Resuelve una conversación "por revisar": la mueve a la titular elegida, le guarda el
 * whatsapp_id si no tenía, vincula a los otros como a cargo y apaga la marca. Una transacción.
 * Si la titular ya tenía conversación del mismo canal, se fusionan en la de ella (índice único
 * contact_id + channel) y se devuelve ese id.
 */
export async function resolverConversacion(
  db: Db,
  conversationId: string,
  input: {
    titularId: string;
    otros: { contactId: string; relationship: Relationship; relationshipOther?: string }[];
  },
): Promise<{ conversationId: string }> {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for("update")
      .limit(1);
    if (!conv) throw notFound("Conversation");
    if (!conv.contactId) throw badRequest("La conversación no tiene contacto");

    const [actual] = await tx.select().from(contacts).where(eq(contacts.id, conv.contactId)).limit(1);
    if (!actual) throw notFound("Contact");
    const [titular] = await tx.select().from(contacts).where(eq(contacts.id, input.titularId)).limit(1);
    if (!titular) throw notFound("Contact (titular)");

    const claves = new Set([clave(actual.whatsappId), clave(actual.phone)].filter((k): k is string => !!k));
    const comparte =
      titular.id === actual.id ||
      [clave(titular.phone), clave(titular.whatsappId)].some((k) => k !== null && claves.has(k));
    if (!comparte) throw badRequest("La titular no comparte el número de la conversación");
    if (titular.holderContactId) throw badRequest("Esa persona está a cargo de otra: no puede ser titular");

    const vistos = new Set<string>();
    for (const o of input.otros) {
      if (o.contactId === titular.id) throw badRequest("La titular no puede quedar a cargo de sí misma");
      if (vistos.has(o.contactId)) throw badRequest("Persona repetida en la lista");
      vistos.add(o.contactId);
    }
    // Todo contacto que comparta el número (y la ficha actual) tiene que ser la titular o quedar a
    // cargo de ella; si no, el webhook vuelve a ver dos fichas sin vínculo y re-marca "por revisar".
    const mismos = new Set<string>([actual.id]);
    for (const r of await fichasQueCompartenNumero(tx, actual)) {
      if (r.holderContactId !== titular.id) mismos.add(r.id);
    }
    mismos.delete(titular.id);
    if ([...mismos].some((id) => !vistos.has(id))) {
      throw badRequest("Todas las demás fichas que usan este número tienen que quedar a cargo de la titular");
    }
    for (const o of input.otros) {
      await setTitular(tx, o.contactId, {
        holderContactId: titular.id,
        relationship: o.relationship,
        relationshipOther: o.relationshipOther,
      });
    }

    let finalId = conversationId;
    if (actual.id !== titular.id) {
      const [existente] = conv.channel
        ? await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(and(eq(conversations.contactId, titular.id), eq(conversations.channel, conv.channel)))
            .for("update")
            .limit(1)
        : [];
      if (existente) {
        await fusionarConversacion(tx, conversationId, existente.id);
        finalId = existente.id;
      } else {
        await tx.update(conversations).set({ contactId: titular.id }).where(eq(conversations.id, conversationId));
      }
    }
    await tx.update(conversations).set({ needsContactReview: false }).where(eq(conversations.id, finalId));

    if (!titular.whatsappId) {
      const k = [...claves][0] ?? clave(titular.phone);
      if (k) await tx.update(contacts).set({ whatsappId: `549${k}` }).where(eq(contacts.id, titular.id));
    }
    return { conversationId: finalId };
  });
}
