import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
// @ts-ignore -- el proyecto no incluye @types/node; vitest corre en Node
import { execSync } from "node:child_process";
import { aWhatsappId } from "../../lib/telefono";

/**
 * Migraciones de datos 1.71.0/02 (WhatsApp ID desde el teléfono) y /03 (limpieza sin teléfono).
 * Los datos de prueba llevan el prefijo ZZ_QA_DAT_ en `name` (se busca con starts_with: en LIKE el
 * `_` es comodín).
 */
const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const sql = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const M02 = "src/db/migrations/1.71.0/02-whatsapp-id-desde-telefono.sql";
const M03 = "src/db/migrations/1.71.0/03-limpieza-sin-telefono.sql";
const PREFIJO = "ZZ_QA_DAT_";
const RUN = `${PREFIJO}${Date.now()}_`;

function aplicar(archivo: string): string {
  return execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${archivo}" 2>&1`,
    { stdio: "pipe" },
  ).toString();
}

async function contacto(etiqueta: string, phone: string | null, extra: { whatsapp?: string; tags?: string[] } = {}) {
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO contacts (id, name, phone, whatsapp_id, tags)
    VALUES (gen_random_uuid(), ${RUN + etiqueta}, ${phone}, ${extra.whatsapp ?? null}, ${extra.tags ? `{${extra.tags.join(",")}}` : null}::text[])
    RETURNING id`;
  return r!.id;
}
async function cliente(contactId: string, creditBalance = 0) {
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO customers (id, contact_id, credit_balance)
    VALUES (gen_random_uuid(), ${contactId}, ${creditBalance}) RETURNING id`;
  return r!.id;
}
const existeContacto = async (id: string) =>
  (await sql`SELECT 1 FROM contacts WHERE id = ${id}`).length === 1;
const existeCliente = async (id: string) =>
  (await sql`SELECT 1 FROM customers WHERE id = ${id}`).length === 1;
async function fila(id: string) {
  const [r] = await sql<{ whatsapp_id: string | null; tags: string[] | null; phone: string | null }[]>`
    SELECT whatsapp_id, to_json(tags) AS tags, phone FROM contacts WHERE id = ${id}`;
  return r!;
}

async function limpiar() {
  const ids = sql`SELECT id FROM contacts WHERE starts_with(name, ${PREFIJO})`;
  const clientes = sql`SELECT id FROM customers WHERE contact_id IN (${ids})`;
  await sql`DELETE FROM invoices WHERE customer_id IN (${clientes})`;
  await sql`DELETE FROM customer_credit_movements WHERE customer_id IN (${clientes})`;
  await sql`DELETE FROM contact_notes WHERE contact_id IN (${ids})`;
  await sql`DELETE FROM deals WHERE contact_id IN (${ids})`;
  await sql`DELETE FROM conversations WHERE contact_id IN (${ids})`;
  await sql`DELETE FROM automation_runs WHERE contact_id IN (${ids})`;
  await sql`UPDATE contacts SET holder_contact_id = NULL WHERE starts_with(name, ${PREFIJO})`;
  await sql`DELETE FROM customers WHERE contact_id IN (${ids})`;
  await sql`DELETE FROM contacts WHERE starts_with(name, ${PREFIJO})`;
}

afterAll(async () => {
  await limpiar();
  await sql.end();
});

describe("1.71.0/02 — WhatsApp ID desde el teléfono", () => {
  // La misma tabla de casos que src/lib/telefono.test.ts. Se cambian los últimos 4 dígitos de cada
  // número por uno distinto por caso, para que ninguno comparta clave con otro (ni con datos reales).
  const casos = [
    "005491130317884", "+54 9 11 3031-7884", "5491130317884", "541130317884", "1130317884",
    "3413285292", "1530317884", "11 15 3031 7884", "01130317884", "03484688322", "111111",
    "159447519", "005216643206631", "0013852837291",
  ];
  const ids: { tel: string; id: string }[] = [];
  let compartidoA: string, compartidoB: string, conWa: string, conWaPrevio: string;

  beforeAll(async () => {
    await limpiar();
    for (const [i, original] of casos.entries()) {
      const cola = String(7000 + i);
      const tel = original.replace(/\d{4}(?=\D*$)/, cola);
      ids.push({ tel, id: await contacto(`caso${i}`, tel) });
    }
    compartidoA = await contacto("compA", "1155550001");
    compartidoB = await contacto("compB", "+54 9 11 5555-0001");
    conWa = await contacto("conWa", "1144440002", { whatsapp: "5490000000000" });
    conWaPrevio = await contacto("sinWa", "1144440003", { whatsapp: "" });
    aplicar(M02);
  });

  it("da lo mismo que aWhatsappId para cada caso de la tabla de teléfonos", async () => {
    for (const { tel, id } of ids) {
      const esperado = aWhatsappId(tel);
      expect({ tel, wa: (await fila(id)).whatsapp_id }).toEqual({ tel, wa: esperado });
    }
  });

  it("005491130317884 único recibe 549 + 10 dígitos", async () => {
    expect((await fila(ids[0]!.id)).whatsapp_id).toBe("549113031" + "7000");
  });

  it("1530317884 (con 15) no recibe", async () => {
    expect((await fila(ids[6]!.id)).whatsapp_id).toBeNull();
  });

  it("dos contactos con el mismo número (aunque escrito distinto) no reciben", async () => {
    expect((await fila(compartidoA)).whatsapp_id).toBeNull();
    expect((await fila(compartidoB)).whatsapp_id).toBeNull();
  });

  it("no pisa un whatsapp_id existente", async () => {
    expect((await fila(conWa)).whatsapp_id).toBe("5490000000000");
  });

  it("whatsapp_id vacío se completa", async () => {
    expect((await fila(conWaPrevio)).whatsapp_id).toBe("5491144440003");
  });

  it("es idempotente", async () => {
    const antes = await sql`SELECT id, whatsapp_id FROM contacts WHERE starts_with(name, ${RUN}) ORDER BY id`;
    aplicar(M02);
    aplicar(M02);
    const despues = await sql`SELECT id, whatsapp_id FROM contacts WHERE starts_with(name, ${RUN}) ORDER BY id`;
    expect(despues).toEqual(antes);
  });

  it("no pisa si otro contacto ya tiene ese WhatsApp ID", async () => {
    const dueno = await contacto("duenoWa", "1166660001", { whatsapp: "5491166660009" });
    const nuevo = await contacto("candidatoWa", "1166660009");
    aplicar(M02);
    expect((await fila(nuevo)).whatsapp_id).toBeNull();
    expect((await fila(dueno)).whatsapp_id).toBe("5491166660009");
  });
});

describe("1.71.0/03 — limpieza de contactos sin teléfono", () => {
  const c: Record<string, { contacto: string; cliente?: string }> = {};

  async function caso(etiqueta: string, phone: string | null, conCliente = true, credit = 0) {
    const id = await contacto(etiqueta, phone);
    c[etiqueta] = { contacto: id, cliente: conCliente ? await cliente(id, credit) : undefined };
    return c[etiqueta]!;
  }

  beforeAll(async () => {
    await limpiar();
    await caso("vacio", null);
    await caso("vacioCorto", "12345", false);
    await caso("vacioString", "");
    const f = await caso("factura", null);
    await sql`INSERT INTO invoices (id, customer_id) VALUES (gen_random_uuid(), ${f.cliente!})`;
    const n = await caso("nota", "111", false);
    await sql`INSERT INTO contact_notes (contact_id, body) VALUES (${n.contacto}, 'x')`;
    const d = await caso("deal", null);
    await sql`INSERT INTO deals (id, contact_id) VALUES (gen_random_uuid(), ${d.contacto})`;
    const a = await caso("automation", null, false);
    await sql`INSERT INTO automation_runs (contact_id) VALUES (${a.contacto})`;
    const cv = await caso("conversa", null, false);
    await sql`INSERT INTO conversations (id, contact_id, channel) VALUES (gen_random_uuid(), ${cv.contacto}, 'whatsapp')`;
    const t = await caso("titular", null, false);
    const aCargo = await contacto("aCargo", "1177770001");
    await sql`UPDATE contacts SET holder_contact_id = ${t.contacto} WHERE id = ${aCargo}`;
    await caso("saldo", null, true, 500);
    const conTag = await caso("yaEtiquetado", null, false);
    await sql`UPDATE contacts SET tags = ARRAY['vip'] WHERE id = ${conTag.contacto}`;
    await sql`INSERT INTO contact_notes (contact_id, body) VALUES (${conTag.contacto}, 'x')`;
    c.valido = { contacto: await contacto("valido", "1130317884", { tags: ["vip"] }) };
    c.valido!.cliente = await cliente(c.valido!.contacto);
    aplicar(M03);
  });

  it("sin teléfono y sin nada: se borran el contacto y su customer (NULL, corto y vacío)", async () => {
    for (const k of ["vacio", "vacioCorto", "vacioString"]) {
      expect(await existeContacto(c[k]!.contacto), k).toBe(false);
      if (c[k]!.cliente) expect(await existeCliente(c[k]!.cliente!), k).toBe(false);
    }
  });

  it.each(["factura", "nota", "deal", "automation", "conversa", "titular", "saldo"])(
    "con referencia (%s): no se borra y queda con sin-telefono",
    async (k) => {
      expect(await existeContacto(c[k]!.contacto)).toBe(true);
      if (c[k]!.cliente) expect(await existeCliente(c[k]!.cliente!)).toBe(true);
      expect((await fila(c[k]!.contacto)).tags).toContain("sin-telefono");
    },
  );

  it("conserva las etiquetas que ya tenía y agrega sin-telefono una sola vez", async () => {
    expect((await fila(c.yaEtiquetado!.contacto)).tags).toEqual(["vip", "sin-telefono"]);
  });

  it("con teléfono válido: intacto", async () => {
    expect(await existeContacto(c.valido!.contacto)).toBe(true);
    expect(await existeCliente(c.valido!.cliente!)).toBe(true);
    expect((await fila(c.valido!.contacto)).tags ?? []).not.toContain("sin-telefono");
  });

  it("la persona a cargo (con teléfono) sigue ahí", async () => {
    const [r] = await sql`SELECT 1 FROM contacts WHERE starts_with(name, ${RUN + "aCargo"})`;
    expect(r).toBeTruthy();
  });

  it("es idempotente (no duplica la etiqueta ni borra más)", async () => {
    aplicar(M03);
    aplicar(M03);
    expect((await fila(c.yaEtiquetado!.contacto)).tags).toEqual(["vip", "sin-telefono"]);
    expect((await fila(c.factura!.contacto)).tags).toEqual(["sin-telefono"]);
    expect(await existeContacto(c.nota!.contacto)).toBe(true);
  });

  it("avisa con RAISE NOTICE cuántos borró y cuántos etiquetó", async () => {
    const v = await contacto("avisoVacio", null);
    await cliente(v);
    expect(aplicar(M03)).toMatch(/borrados: 1/);
  });
});
