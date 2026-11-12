import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts } from "../db/schema";
import { badRequest, notFound } from "../lib/errors";
import { clave } from "../lib/telefono";

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

  const k = clave(yo.phone);
  let compartenNumero: { id: string; name: string | null }[] = [];
  if (k) {
    const vinculados = new Set<string>([
      contactId,
      ...(yo.holderContactId ? [yo.holderContactId] : []),
      ...aCargo.map((p) => p.id),
    ]);
    const mismos = await db
      .select({ id: contacts.id, name: contacts.name })
      .from(contacts)
      .where(
        and(
          sql`${contacts.isArchived} IS NOT TRUE`,
          ne(contacts.id, contactId),
          sql`right(regexp_replace(${contacts.phone}, '\\D', '', 'g'), 10) = ${k}`,
        ),
      )
      .orderBy(asc(contacts.createdAt), asc(contacts.id));
    compartenNumero = mismos.filter((m) => !vinculados.has(m.id));
  }

  return { titular: titularConParentesco, aCargo, compartenNumero };
}

export async function setTitular(
  db: Db,
  contactId: string,
  input: { holderContactId: string | null; relationship?: Relationship; relationshipOther?: string },
): Promise<void> {
  const [yo] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!yo) throw notFound("Contact");

  if (input.holderContactId === null) {
    await db
      .update(contacts)
      .set({ holderContactId: null, relationship: null, relationshipOther: null })
      .where(eq(contacts.id, contactId));
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
