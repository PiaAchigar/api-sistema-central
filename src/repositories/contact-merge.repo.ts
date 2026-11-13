import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { badRequest, conflict, internal, notFound } from "../lib/errors";
import { fichasQueCompartenNumero } from "./contact-links.repo";

/**
 * Unir dos fichas de contacto: `keepId` (A) queda, `dupId` (B) desaparece.
 *
 * El reapuntado es GENÉRICO: las FK se leen de `pg_constraint` en el momento, así una tabla nueva
 * que apunte a contacts/customers/conversations no se queda colgada de B. Las únicas excepciones
 * se tratan aparte y ANTES del barrido genérico, porque borrar B (o su conversación / customer)
 * dispara ON DELETE CASCADE / SET NULL / RESTRICT sobre lo que no se haya movido:
 *   - conversations: índice único (contact_id, channel) → se fusionan los hilos.
 *   - customers: si los dos tienen, se fusionan los saldos y se reapunta todo al de A.
 *   - contacts.holder_contact_id: reglas de un solo nivel (titular / a cargo).
 */

type Tx = Db;
type Fk = { esquema: string; tabla: string; columna: string };

const ref = (f: Fk) => sql`${sql.identifier(f.esquema)}.${sql.identifier(f.tabla)}`;

/** FK de una columna que referencian `destino` (nombre de tabla en public). */
export async function fksHacia(tx: Tx, destino: "contacts" | "customers" | "conversations"): Promise<Fk[]> {
  const rows = (await tx.execute(sql`
    SELECT n.nspname AS esquema, c.relname AS tabla, a.attname AS columna,
           cardinality(con.conkey) AS ncols
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = ${`public.${destino}`}::regclass
    ORDER BY c.relname, a.attname
  `)) as unknown as (Fk & { ncols: number })[];
  const vistos = new Set<string>();
  const out: Fk[] = [];
  for (const r of rows) {
    if (Number(r.ncols) !== 1) {
      throw internal(`FK compuesta hacia ${destino} en ${r.tabla}: la unión no sabe reapuntarla`);
    }
    const k = `${r.esquema}.${r.tabla}.${r.columna}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push({ esquema: r.esquema, tabla: r.tabla, columna: r.columna });
  }
  return out;
}

async function reapuntar(tx: Tx, fks: Fk[], de: string, a: string) {
  for (const f of fks) {
    await tx.execute(
      sql`UPDATE ${ref(f)} SET ${sql.identifier(f.columna)} = ${a} WHERE ${sql.identifier(f.columna)} = ${de}`,
    );
  }
}

/**
 * Mueve todo lo que cuelga de la conversación `origen` a `destino` (mensajes, cola, delivery_logs,
 * lo que aparezca) y recién ahí borra `origen`: varias de esas FK son ON DELETE CASCADE.
 */
export async function fusionarConversacion(tx: Tx, origenId: string, destinoId: string) {
  const fks = await fksHacia(tx, "conversations");
  await reapuntar(tx, fks, origenId, destinoId);
  // automation_runs no tiene FK: el barrido por pg_constraint no la ve.
  await tx.execute(sql`UPDATE automation_runs SET conversation_id = ${destinoId} WHERE conversation_id = ${origenId}`);
  await tx.execute(sql`
    UPDATE conversations d SET
      message_count = (SELECT count(*) FROM messages WHERE conversation_id = d.id),
      last_message_at = (
        SELECT max(t) FROM (
          SELECT d.last_message_at AS t
          UNION ALL SELECT o.last_message_at FROM conversations o WHERE o.id = ${origenId}
        ) x
      ),
      needs_contact_review = d.needs_contact_review OR COALESCE(
        (SELECT o.needs_contact_review FROM conversations o WHERE o.id = ${origenId}), false)
    WHERE d.id = ${destinoId}
  `);
  await tx.execute(sql`DELETE FROM conversations WHERE id = ${origenId}`);
}

type Counts = {
  pierdeTitular: boolean;
  conversaciones: number;
  turnos: number;
  pagos: number;
  facturas: number;
  compras: number;
  aCargo: number;
};

export async function previewUnion(db: Db, keepId: string, dupId: string): Promise<Counts> {
  const { a } = await cargarPar(db, keepId, dupId);
  const [r] = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM conversations WHERE contact_id = ${dupId})::int AS conversaciones,
      (SELECT count(*) FROM appointments WHERE customer_id IN (SELECT id FROM customers WHERE contact_id = ${dupId}))::int AS turnos,
      (SELECT count(*) FROM payments WHERE customer_id IN (SELECT id FROM customers WHERE contact_id = ${dupId}))::int AS pagos,
      (SELECT count(*) FROM invoices WHERE customer_id IN (SELECT id FROM customers WHERE contact_id = ${dupId}))::int AS facturas,
      (SELECT count(*) FROM customer_purchase WHERE customer_id IN (SELECT id FROM customers WHERE contact_id = ${dupId}))::int AS compras,
      (SELECT count(*) FROM contacts WHERE holder_contact_id = ${dupId} AND id <> ${keepId})::int AS "aCargo"
  `)) as unknown as Omit<Counts, "pierdeTitular">[];
  // A pierde su titular si estaba a cargo de otra (no de B) y va a quedar con personas a cargo.
  const holderA = (a.holder_contact_id as string | null) ?? null;
  const [propios] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM contacts WHERE holder_contact_id = ${keepId}`,
  )) as unknown as { n: number }[];
  const pierdeTitular = !!holderA && holderA !== dupId && (r!.aCargo > 0 || (propios?.n ?? 0) > 0);
  return { ...r!, pierdeTitular };
}

type Fila = Record<string, unknown>;

async function cargarPar(tx: Tx, keepId: string, dupId: string, lock = false) {
  if (keepId === dupId) throw badRequest("No se puede unir una ficha consigo misma");
  const rows = (await tx.execute(
    lock
      ? sql`SELECT * FROM contacts WHERE id IN (${keepId}, ${dupId}) ORDER BY id FOR UPDATE`
      : sql`SELECT * FROM contacts WHERE id IN (${keepId}, ${dupId})`,
  )) as unknown as Fila[];
  const a = rows.find((r) => r.id === keepId);
  const b = rows.find((r) => r.id === dupId);
  if (!a) throw notFound("Contact");
  if (!b) throw notFound("Contact (duplicado)");
  return { a, b };
}

const cargado = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";

export async function unirContactos(db: Db, keepId: string, dupId: string): Promise<void> {
  try {
    await unirEnTransaccion(db, keepId, dupId);
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
    const code = err.code ?? err.cause?.code;
    if (code === "23505") {
      const c = err.constraint_name ?? err.cause?.constraint_name ?? "";
      if (c.includes("appt") || c.includes("appointments")) {
        throw conflict("No se pueden unir: las dos fichas tienen un turno en la misma clase o encuentro. Cancelá uno antes de unir.");
      }
      if (c.includes("training_subscriptions")) {
        throw conflict("No se pueden unir: las dos fichas tienen una suscripción activa a la misma actividad. Cancelá una antes de unir.");
      }
      throw conflict("No se pueden unir: las dos fichas tienen datos que se pisan entre sí. Revisalas antes de unir.");
    }
    throw e;
  }
}

async function unirEnTransaccion(db: Db, keepId: string, dupId: string): Promise<void> {
  await db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Tx;
    const { a, b } = await cargarPar(tx, keepId, dupId, true);

    const custA = (await tx.execute(
      sql`SELECT * FROM customers WHERE contact_id = ${keepId} ORDER BY created_at NULLS LAST, id FOR UPDATE`,
    )) as unknown as Fila[];
    const custB = (await tx.execute(
      sql`SELECT * FROM customers WHERE contact_id = ${dupId} ORDER BY created_at NULLS LAST, id FOR UPDATE`,
    )) as unknown as Fila[];

    // DNI / CUIT distintos con ambos cargados: son personas distintas.
    for (const campo of ["dni", "cuit"] as const) {
      const va = custA.map((c) => c[campo]).filter(cargado).map((v) => String(v).trim());
      const vb = custB.map((c) => c[campo]).filter(cargado).map((v) => String(v).trim());
      if (va.length && vb.length && !vb.every((v) => va.includes(v))) {
        throw conflict(`Las dos fichas tienen ${campo.toUpperCase()} distinto: son personas distintas`);
      }
    }

    // 1) Conversaciones (índice único contact_id + channel).
    const convB = (await tx.execute(
      sql`SELECT id, channel FROM conversations WHERE contact_id = ${dupId} ORDER BY created_at NULLS LAST, id`,
    )) as unknown as { id: string; channel: string | null }[];
    for (const cb of convB) {
      const [ca] = cb.channel === null
        ? []
        : ((await tx.execute(
            sql`SELECT id FROM conversations WHERE contact_id = ${keepId} AND channel = ${cb.channel} FOR UPDATE`,
          )) as unknown as { id: string }[]);
      if (ca) await fusionarConversacion(tx, cb.id, ca.id);
      else await tx.execute(sql`UPDATE conversations SET contact_id = ${keepId} WHERE id = ${cb.id}`);
    }

    // 2) Customers: si los dos tienen, todo lo de los de B va al primero de A y se borran los de B.
    if (custA.length > 0 && custB.length > 0) {
      const destino = custA[0]!;
      const destinoId = destino.id as string;
      const fksCust = (await fksHacia(tx, "customers")).filter(
        (f) => !(f.tabla === "customers" && f.columna === "contact_id"),
      );
      for (const cb of custB) {
        const origenId = cb.id as string;
        await reapuntar(tx, fksCust, origenId, destinoId);
        await tx.execute(sql`
          UPDATE customers d SET
            credit_balance = COALESCE(d.credit_balance, 0) + COALESCE(o.credit_balance, 0),
            dni = COALESCE(NULLIF(d.dni, ''), o.dni),
            cuit = COALESCE(NULLIF(d.cuit, ''), o.cuit),
            tax_id = COALESCE(NULLIF(d.tax_id, ''), o.tax_id),
            first_purchase_date = CASE
              WHEN d.first_purchase_date IS NULL THEN o.first_purchase_date
              WHEN o.first_purchase_date IS NULL THEN d.first_purchase_date
              ELSE LEAST(d.first_purchase_date, o.first_purchase_date) END,
            updated_at = now()
          FROM customers o
          WHERE d.id = ${destinoId} AND o.id = ${origenId}
        `);
        await tx.execute(sql`DELETE FROM customers WHERE id = ${origenId}`);
      }
    }

    // 3) Titular / a cargo (un solo nivel). Antes del barrido y antes del DELETE: SET NULL.
    const holderA = (a.holder_contact_id as string | null) ?? null;
    const holderB = (b.holder_contact_id as string | null) ?? null;
    // Terceros a cargo de B pasan a A (A misma, si estaba a cargo de B, se trata abajo).
    await tx.execute(
      sql`UPDATE contacts SET holder_contact_id = ${keepId} WHERE holder_contact_id = ${dupId} AND id <> ${keepId}`,
    );
    const [fila] = (await tx.execute(
      sql`SELECT count(*)::int AS n FROM contacts WHERE holder_contact_id = ${keepId}`,
    )) as unknown as { n: number }[];
    const aTieneACargo = (fila?.n ?? 0) > 0;

    let nuevoHolder: string | null = holderA === dupId ? null : holderA;
    let rel = holderA === dupId ? null : (a.relationship as string | null);
    let relOtro = holderA === dupId ? null : (a.relationship_other as string | null);
    if (aTieneACargo) {
      // Quien tiene personas a cargo no puede estar a cargo de otra.
      nuevoHolder = null;
      rel = null;
      relOtro = null;
    } else if (!nuevoHolder && holderB && holderB !== keepId) {
      nuevoHolder = holderB;
      rel = b.relationship as string | null;
      relOtro = b.relationship_other as string | null;
    }
    // Soltar a A de B antes del DELETE (si no, SET NULL lo haría igual, pero acá queda explícito).
    await tx.execute(sql`
      UPDATE contacts SET holder_contact_id = ${nuevoHolder}, relationship = ${rel}, relationship_other = ${relOtro}
      WHERE id = ${keepId}
    `);

    // 4) Barrido genérico de todo lo que apunte a B (contacts), salvo holder_contact_id.
    const fksContact = (await fksHacia(tx, "contacts")).filter(
      (f) => !(f.tabla === "contacts" && f.columna === "holder_contact_id"),
    );
    await reapuntar(tx, fksContact, dupId, keepId);
    // Sin FK, no las ve el barrido: la spec las nombra.
    await tx.execute(sql`UPDATE automation_runs SET contact_id = ${keepId} WHERE contact_id = ${dupId}`);

    // 5) Datos: se completan vacíos de A con B; nunca se pisa lo cargado.
    const campos = [
      "name", "email", "phone", "whatsapp_id", "instagram_id", "facebook_id", "telegram_id",
      "birthdate", "address", "city", "postal_code", "country", "status", "preferred_service", "sexo",
    ];
    const textuales = new Set([
      "name", "email", "phone", "whatsapp_id", "instagram_id", "facebook_id", "telegram_id",
      "address", "city", "postal_code", "country", "status", "preferred_service", "sexo",
    ]);
    const sets = campos.map((c) => {
      const col = sql.identifier(c);
      return textuales.has(c)
        ? sql`${col} = COALESCE(NULLIF(a.${col}, ''), b.${col})`
        : sql`${col} = COALESCE(a.${col}, b.${col})`;
    });
    await tx.execute(sql`
      UPDATE contacts a SET
        ${sql.join(sets, sql`, `)},
        first_contact_date = CASE
          WHEN a.first_contact_date IS NULL THEN b.first_contact_date
          WHEN b.first_contact_date IS NULL THEN a.first_contact_date
          ELSE LEAST(a.first_contact_date, b.first_contact_date) END,
        last_visit_date = CASE
          WHEN a.last_visit_date IS NULL THEN b.last_visit_date
          WHEN b.last_visit_date IS NULL THEN a.last_visit_date
          ELSE GREATEST(a.last_visit_date, b.last_visit_date) END,
        tags = CASE WHEN a.tags IS NULL AND b.tags IS NULL THEN NULL ELSE ARRAY(
          SELECT x FROM (
            SELECT x, min(o) AS o
            FROM unnest(COALESCE(a.tags, '{}') || COALESCE(b.tags, '{}')) WITH ORDINALITY t(x, o)
            GROUP BY x
          ) s ORDER BY o) END,
        notes = CASE
          WHEN NULLIF(trim(COALESCE(a.notes, '')), '') IS NULL THEN b.notes
          WHEN NULLIF(trim(COALESCE(b.notes, '')), '') IS NULL OR a.notes = b.notes THEN a.notes
          ELSE a.notes || E'\n---\n' || b.notes END,
        custom_fields_json = CASE
          WHEN a.custom_fields_json IS NULL THEN b.custom_fields_json
          WHEN b.custom_fields_json IS NULL THEN a.custom_fields_json
          WHEN jsonb_typeof(a.custom_fields_json) = 'object' AND jsonb_typeof(b.custom_fields_json) = 'object'
            THEN b.custom_fields_json || a.custom_fields_json
          ELSE a.custom_fields_json END,
        updated_at = now()
      FROM contacts b
      WHERE a.id = ${keepId} AND b.id = ${dupId}
    `);

    // 5b) Si B traía un teléfono o WhatsApp con otra clave que los que quedaron en A, no se pierden:
    // quedan anotados en las notas (A ya hereda phone/whatsapp_id de B cuando los tenía vacíos).
    const k = (col: ReturnType<typeof sql.identifier>, t: "a" | "b") =>
      sql`right(regexp_replace(COALESCE(${sql.raw(t)}.${col}, ''), '\\D', '', 'g'), 10)`;
    const kPhone = sql.identifier("phone");
    const kWa = sql.identifier("whatsapp_id");
    await tx.execute(sql`
      UPDATE contacts a SET notes = CASE
          WHEN NULLIF(trim(COALESCE(a.notes, '')), '') IS NULL THEN x.linea
          ELSE a.notes || E'\n---\n' || x.linea END
      FROM (
        SELECT b.id,
          'Unido con ' || COALESCE(b.name, 'otra ficha') || ': ' || concat_ws(', ',
            CASE WHEN ${k(kPhone, "b")} <> '' AND ${k(kPhone, "b")} <> ${k(kPhone, "a")}
                 THEN 'tel ' || b.phone END,
            CASE WHEN ${k(kWa, "b")} <> '' AND ${k(kWa, "b")} <> ${k(kWa, "a")}
                 THEN 'WhatsApp ' || b.whatsapp_id END) AS linea,
          (${k(kPhone, "b")} <> '' AND ${k(kPhone, "b")} <> ${k(kPhone, "a")})
          OR (${k(kWa, "b")} <> '' AND ${k(kWa, "b")} <> ${k(kWa, "a")}) AS hay
        FROM contacts a JOIN contacts b ON b.id = ${dupId}
        WHERE a.id = ${keepId}
      ) x
      WHERE a.id = ${keepId} AND x.hay
    `);

    // 6) Red de seguridad: si algo todavía apunta a B, abortar (rollback) en vez de arrastrarlo.
    for (const f of [...fksContact, { esquema: "public", tabla: "contacts", columna: "holder_contact_id" }]) {
      const [filaResto] = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM ${ref(f)} WHERE ${sql.identifier(f.columna)} = ${dupId}`,
      )) as unknown as { n: number }[];
      if ((filaResto?.n ?? 0) > 0) throw internal(`Quedó ${f.tabla}.${f.columna} apuntando a la ficha duplicada`);
    }

    await tx.execute(sql`DELETE FROM contacts WHERE id = ${dupId}`);

    // 7) "Por revisar": si ya no queda otra ficha con el número de A, la duda se resolvió sola.
    const [sobreviviente] = (await tx.execute(
      sql`SELECT id, phone, whatsapp_id AS "whatsappId" FROM contacts WHERE id = ${keepId}`,
    )) as unknown as { id: string; phone: string | null; whatsappId: string | null }[];
    if (sobreviviente && (await fichasQueCompartenNumero(tx, sobreviviente)).length === 0) {
      await tx.execute(sql`UPDATE conversations SET needs_contact_review = false WHERE contact_id = ${keepId}`);
    }
  });
}
