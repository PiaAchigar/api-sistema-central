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
    return c.json({ error: err.message }, err.status as 400 | 404);
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
