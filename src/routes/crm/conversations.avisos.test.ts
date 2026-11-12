import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import type { AppBindings, Variables } from "../../env";
import { conversationsRouter } from "./conversations";
import { auth } from "../../middleware/auth";

vi.mock("../../middleware/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../middleware/auth")>();
  return {
    ...real,
    auth: async (c: any, next: any) => {
      const rol = c.req.header("x-test-rol");
      if (!rol) return real.auth(c, next);
      c.set("userId", "00000000-0000-0000-0000-000000000001");
      c.set("userRole", rol);
      c.set("userEmail", null);
      return next();
    },
  };
});

const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const pg = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const API_KEY = "qa-avisos-test-key";
const ENV = { HYPERDRIVE: { connectionString: URL_DB }, API_KEY } as unknown as AppBindings;
const QA = "ZZ_QA_AVISOS_";

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.onError((err, c) => {
  if ("status" in err && typeof err.status === "number") {
    return c.json({ error: err.message }, err.status as 400 | 404);
  }
  return c.json({ error: "Internal server error" }, 500);
});
app.use("*", auth);
app.route("/conversations", conversationsRouter);

const pedir = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: "GET", headers: { Authorization: `Bearer ${API_KEY}`, ...headers } }, ENV);

type Aviso = { id: string; conversationId: string; contactName: string | null; content: string; createdAt: string };
type Resp = { mensajes: Aviso[]; hasta: string };

async function conversacion(nombre: string) {
  const [ct] = await pg<{ id: string }[]>`
    INSERT INTO contacts (id, name, is_archived) VALUES (gen_random_uuid(), ${QA + nombre}, false) RETURNING id`;
  const [cv] = await pg<{ id: string }[]>`
    INSERT INTO conversations (id, contact_id, channel, status) VALUES (gen_random_uuid(), ${ct!.id}, 'whatsapp', 'open') RETURNING id`;
  return cv!.id;
}
async function mensaje(conv: string, tipo: string, contenido: string, iso: string) {
  await pg`INSERT INTO messages (id, conversation_id, sender_type, content, created_at)
    VALUES (gen_random_uuid(), ${conv}, ${tipo}, ${contenido}, ${iso}::timestamp)`;
}

async function limpiar() {
  await pg`DELETE FROM messages WHERE conversation_id IN (SELECT cv.id FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE c.name LIKE ${QA + "%"})`;
  await pg`DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE ${QA + "%"})`;
  await pg`DELETE FROM contacts WHERE name LIKE ${QA + "%"}`;
}
afterEach(limpiar);
afterAll(async () => {
  await limpiar();
  await pg.end();
});

describe("GET /conversations/avisos", () => {
  it("sin desde: no avisa nada y devuelve la hora del servidor", async () => {
    const conv = await conversacion("A");
    await mensaje(conv, "contact", "viejo", "2020-01-01T10:00:00Z");
    const antes = Date.now();
    const res = await pedir("/conversations/avisos");
    expect(res.status).toBe(200);
    const j = (await res.json()) as Resp;
    expect(j.mensajes).toEqual([]);
    expect(Math.abs(new Date(j.hasta).getTime() - antes)).toBeLessThan(10_000);
  });

  it("filtra los del agente y los anteriores a desde; trae nombre y hasta", async () => {
    const conv = await conversacion("B");
    await mensaje(conv, "contact", "anterior", "2020-01-01T10:00:00Z");
    await mensaje(conv, "agent", "respuesta mía", "2020-01-01T10:01:30Z");
    await mensaje(conv, "contact", "hola 1", "2020-01-01T10:02:00Z");
    await mensaje(conv, "contact", "hola 2", "2020-01-01T10:03:00Z");
    const res = await pedir("/conversations/avisos?desde=2020-01-01T10:01:00.000Z");
    const j = (await res.json()) as Resp;
    expect(j.mensajes.map((m) => m.content)).toEqual(["hola 1", "hola 2"]);
    expect(j.mensajes[0]!.contactName).toBe(QA + "B");
    expect(j.mensajes[0]!.conversationId).toBe(conv);
    expect(j.hasta).toBe("2020-01-01T10:03:00.000Z");
    expect(j.mensajes[1]!.createdAt).toBe(j.hasta);
  });

  it("sin mensajes nuevos: hasta es el desde recibido", async () => {
    const desde = "2099-01-01T00:00:00.000Z";
    const j = (await (await pedir(`/conversations/avisos?desde=${desde}`)).json()) as Resp;
    expect(j.mensajes).toEqual([]);
    expect(j.hasta).toBe(desde);
  });

  it("tope de 20, en orden ascendente", async () => {
    const conv = await conversacion("C");
    for (let i = 0; i < 25; i++) {
      await mensaje(conv, "contact", `m${i}`, `2020-02-01T10:00:${String(i).padStart(2, "0")}Z`);
    }
    const j = (await (await pedir("/conversations/avisos?desde=2020-02-01T09:00:00.000Z")).json()) as Resp;
    expect(j.mensajes).toHaveLength(20);
    expect(j.mensajes[0]!.content).toBe("m0");
    expect(j.mensajes[19]!.content).toBe("m19");
    expect(j.hasta).toBe("2020-02-01T10:00:19.000Z");
  });

  it("recorta el contenido a 80 caracteres", async () => {
    const conv = await conversacion("D");
    await mensaje(conv, "contact", "x".repeat(200), "2020-03-01T10:00:00Z");
    const j = (await (await pedir("/conversations/avisos?desde=2020-03-01T09:00:00.000Z")).json()) as Resp;
    expect(j.mensajes[0]!.content).toHaveLength(80);
  });

  it("desde inválido: 400", async () => {
    const res = await pedir("/conversations/avisos?desde=ayer");
    expect(res.status).toBe(400);
  });

  it("sin permiso crm.view: 403", async () => {
    const res = await pedir("/conversations/avisos", { "x-test-rol": "accountant" });
    expect(res.status).toBe(403);
  });

  it("no se confunde con /:id", async () => {
    const res = await pedir("/conversations/avisos");
    expect(res.status).toBe(200);
  });
});
