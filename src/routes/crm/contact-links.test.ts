import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import type { AppBindings, Variables } from "../../env";
import { contactLinksRouter } from "./contact-links";
import { contactsRouter } from "./contacts";
import { auth } from "../../middleware/auth";

const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const pg = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const API_KEY = "qa-contact-links-test-key";
const ENV = { HYPERDRIVE: { connectionString: URL_DB }, API_KEY } as unknown as AppBindings;
const QA = "ZZ_QA_RUTALINK_";

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.onError((err, c) => {
  if ("status" in err && typeof err.status === "number") {
    return c.json({ error: err.message }, err.status as 400 | 404 | 409);
  }
  return c.json({ error: "Internal server error" }, 500);
});
app.use("*", auth);
app.route("/contacts", contactsRouter);
app.route("/contacts", contactLinksRouter);

const pedir = (path: string, method: string, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV,
  );

async function crear(nombre: string, extra: { phone?: string; whatsapp_id?: string } = {}) {
  const [r] = await pg<{ id: string }[]>`
    INSERT INTO contacts (id, name, phone, whatsapp_id, is_archived)
    VALUES (gen_random_uuid(), ${QA + nombre}, ${extra.phone ?? null}, ${extra.whatsapp_id ?? null}, false) RETURNING id`;
  return r!.id;
}

async function limpiar() {
  await pg`UPDATE contacts SET holder_contact_id = NULL, relationship = NULL, relationship_other = NULL WHERE name LIKE ${QA + "%"}`;
  await pg`DELETE FROM contacts WHERE name LIKE ${QA + "%"}`;
}
afterEach(limpiar);
afterAll(async () => {
  await limpiar();
  await pg.end();
});

describe("rutas de vínculos", () => {
  it("PUT titular y GET vinculos", async () => {
    const a = await crear("A");
    const b = await crear("B");
    const put = await pedir(`/contacts/${b}/titular`, "PUT", { holderContactId: a, relationship: "nieta" });
    expect(put.status).toBe(200);
    const res = await pedir(`/contacts/${a}/vinculos`, "GET");
    const j = (await res.json()) as { aCargo: { id: string; relationship: string }[] };
    expect(j.aCargo).toEqual([expect.objectContaining({ id: b, relationship: "nieta" })]);
  });

  it("parentesco fuera de la lista: 400", async () => {
    const a = await crear("A");
    const b = await crear("B");
    const res = await pedir(`/contacts/${b}/titular`, "PUT", { holderContactId: a, relationship: "tia" });
    expect(res.status).toBe(400);
  });

  it("a sí misma: 400 desde la ruta", async () => {
    const a = await crear("A");
    const res = await pedir(`/contacts/${a}/titular`, "PUT", { holderContactId: a, relationship: "hija" });
    expect(res.status).toBe(400);
  });

  it("sin credenciales: 401", async () => {
    const a = await crear("A");
    const res = await app.request(`/contacts/${a}/vinculos`, { method: "GET" }, ENV);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /contacts/:id normaliza whatsappId", () => {
  it("con formato válido guarda 549 + 10 dígitos", async () => {
    const a = await crear("A");
    const res = await pedir(`/contacts/${a}`, "PATCH", { whatsappId: "+54 9 11 3031-7884" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { whatsappId: string }).whatsappId).toBe("5491130317884");
  });

  it("con 15 devuelve 400 { motivo: 'con15' }", async () => {
    const a = await crear("A");
    const res = await pedir(`/contacts/${a}`, "PATCH", { whatsappId: "1530317884" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { motivo: string }).motivo).toBe("con15");
  });
});

describe("rutas de unión", () => {
  it("POST unir une el duplicado en :id y preview cuenta", async () => {
    const a = await crear("A");
    const b = await crear("B");
    await pg`INSERT INTO contact_notes (contact_id, body) VALUES (${b}, 'ZZ_QA_RUTALINK_ nota')`;
    const pre = await pedir(`/contacts/${a}/unir/preview?duplicadoId=${b}`, "GET");
    expect(pre.status).toBe(200);
    expect(((await pre.json()) as { aCargo: number }).aCargo).toBe(0);
    const res = await pedir(`/contacts/${a}/unir`, "POST", { duplicadoId: b });
    expect(res.status).toBe(200);
    expect((await pg`SELECT 1 FROM contacts WHERE id = ${b}`)).toHaveLength(0);
    expect((await pg`SELECT 1 FROM contact_notes WHERE contact_id = ${a}`)).toHaveLength(1);
    await pg`DELETE FROM contact_notes WHERE contact_id = ${a}`;
  });

  it("unir consigo misma: 400; DNI distintos: 409", async () => {
    const a = await crear("A");
    const b = await crear("B");
    expect((await pedir(`/contacts/${a}/unir`, "POST", { duplicadoId: a })).status).toBe(400);
    await pg`INSERT INTO customers (id, contact_id, dni) VALUES (gen_random_uuid(), ${a}, '1')`;
    await pg`INSERT INTO customers (id, contact_id, dni) VALUES (gen_random_uuid(), ${b}, '2')`;
    expect((await pedir(`/contacts/${a}/unir`, "POST", { duplicadoId: b })).status).toBe(409);
    await pg`DELETE FROM customers WHERE contact_id IN (${a}, ${b})`;
  });
});

describe("desvincular con número propio", () => {
  const NUM = "1155559901";
  async function par(hijaExtra: { phone?: string; whatsapp_id?: string } = { phone: NUM, whatsapp_id: "5491155559901" }) {
    const t = await crear("TIT", { phone: NUM, whatsapp_id: "5491155559901" });
    const h = await crear("HIJA", hijaExtra);
    await pg`UPDATE contacts SET holder_contact_id = ${t}, relationship = 'hija' WHERE id = ${h}`;
    return { t, h };
  }
  const leer = async (id: string) =>
    (await pg`SELECT phone, whatsapp_id, holder_contact_id, relationship FROM contacts WHERE id = ${id}`)[0]!;

  it("número válido: desvincula y guarda phone + whatsapp_id 549", async () => {
    const { h } = await par();
    const res = await pedir(`/contacts/${h}/titular`, "PUT", { holderContactId: null, telefonoPropio: "11 4444-5566" });
    expect(res.status).toBe(200);
    const r = await leer(h);
    expect(r.holder_contact_id).toBeNull();
    expect(r.relationship).toBeNull();
    expect(r.whatsapp_id).toBe("5491144445566");
    expect(r.phone).toBe("11 4444-5566");
  });

  it("número con 15: 400 con el motivo y no desvincula", async () => {
    const { t, h } = await par();
    const res = await pedir(`/contacts/${h}/titular`, "PUT", { holderContactId: null, telefonoPropio: "11 15 4444 5566" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("15");
    expect((await leer(h)).holder_contact_id).toBe(t);
  });

  it("número de otra ficha: 409", async () => {
    const { h } = await par();
    await crear("OTRA", { phone: "1166667777", whatsapp_id: "5491166667777" });
    const res = await pedir(`/contacts/${h}/titular`, "PUT", { holderContactId: null, telefonoPropio: "1166667777" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/ya lo tiene/);
  });

  it("null: borra phone y whatsapp_id si eran los de la titular", async () => {
    const { h } = await par();
    const res = await pedir(`/contacts/${h}/titular`, "PUT", { holderContactId: null, telefonoPropio: null });
    expect(res.status).toBe(200);
    const r = await leer(h);
    expect(r.holder_contact_id).toBeNull();
    expect(r.phone).toBeNull();
    expect(r.whatsapp_id).toBeNull();
  });

  it("null: conserva un número propio distinto al de la titular", async () => {
    const { h } = await par({ phone: "1144445566", whatsapp_id: "5491144445566" });
    await pedir(`/contacts/${h}/titular`, "PUT", { holderContactId: null, telefonoPropio: null });
    const r = await leer(h);
    expect(r.phone).toBe("1144445566");
    expect(r.whatsapp_id).toBe("5491144445566");
  });

  it("omitido: no toca los números", async () => {
    const { h } = await par();
    await pedir(`/contacts/${h}/titular`, "PUT", { holderContactId: null });
    const r = await leer(h);
    expect(r.holder_contact_id).toBeNull();
    expect(r.phone).toBe(NUM);
  });
});
