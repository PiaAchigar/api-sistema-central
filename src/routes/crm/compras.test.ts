import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../../db/schema";
import { contacts, customers, depilationCombo } from "../../db/schema";
import type { Db } from "../../db/client";
import type { AppBindings, Variables } from "../../env";
import { compraBody, comprasRouter } from "./compras";

describe("el body de POST /purchases", () => {
  const base = {
    customerId: "11111111-1111-1111-1111-111111111111",
    description: "Promo Novia",
    sessionsTotal: 1,
    baseAmount: 335000,
    discountedAmount: 250000,
    finalAmount: 250000,
  };

  it("acepta un paquete sin ningún origen suelto", () => {
    const r = compraBody.safeParse({
      ...base,
      esPaquete: true,
      promotionId: "22222222-2222-2222-2222-222222222222",
    });
    expect(r.success).toBe(true);
  });

  it("un paquete SIN promo no pasa: sin promo no hay qué desglosar", () => {
    expect(compraBody.safeParse({ ...base, esPaquete: true }).success).toBe(false);
  });

  it("un paquete CON origen suelto no pasa", () => {
    const r = compraBody.safeParse({
      ...base,
      esPaquete: true,
      promotionId: "22222222-2222-2222-2222-222222222222",
      comboId: "33333333-3333-3333-3333-333333333333",
    });
    expect(r.success).toBe(false);
  });

  it("la venta de siempre sigue exigiendo exactamente un origen", () => {
    expect(
      compraBody.safeParse({ ...base, comboId: "33333333-3333-3333-3333-333333333333" }).success,
    ).toBe(true);
    expect(compraBody.safeParse(base).success).toBe(false);
  });
});

// ── POST /purchases/quote — integración real contra Postgres local ─────────
// `sexoDeLaClienta` sólo puede confirmarse llegando hasta la ruta: un doble
// de `Db` no ejercita ni la validación de `customerId` en el union del
// `zValidator` ni el join real hacia `contacts`. Mismo harness que
// `routes/agenda/depilacion.test.ts` (Hono + auth por `x-api-key`, que la
// pasa el mismo `middleware/auth.ts` de siempre y asigna role=admin).
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_COMPRAS_QUOTE";

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const testDb = drizzle(pgClient, { schema }) as unknown as Db;

const API_KEY = "qa-compras-quote-test-key";
const token = API_KEY;
const ENV = { HYPERDRIVE: { connectionString: LOCAL_DB_URL }, API_KEY } as unknown as AppBindings;

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.onError((err, c) => {
  if ("status" in err && typeof err.status === "number") {
    return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502);
  }
  return c.json({ error: "Internal server error" }, 500);
});
app.route("/", comprasRouter);

async function pedirQuote(body: unknown) {
  return app.request(
    "/purchases/quote",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    ENV,
  );
}

async function limpiarClientasQA() {
  const cts = await testDb.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const c of cts) {
    await testDb.delete(customers).where(eq(customers.contactId, c.id));
    await testDb.delete(contacts).where(eq(contacts.id, c.id));
  }
}

async function crearClienta(nombre: string, sexo: "mujer" | "hombre" | null): Promise<string> {
  const [ct] = await testDb.insert(contacts).values({ name: nombre, sexo }).returning({ id: contacts.id });
  const [cu] = await testDb.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  return cu!.id;
}

describe("POST /purchases/quote (integración real)", () => {
  let idClientaMujer = "";
  let idClientaHombre = "";
  let packId = "";

  beforeAll(async () => {
    await limpiarClientasQA();
    idClientaMujer = await crearClienta(`${QA}_MUJER`, "mujer");
    idClientaHombre = await crearClienta(`${QA}_HOMBRE`, "hombre");

    // "Cuerpo Full" es un pack_fijo real (migración 1.35.0) sin
    // `fixed_duration_minutes` propio: `precioDePackFijo` sí lo escala por
    // sexo (duración hombre > duración mujer), a diferencia de un pack con
    // duración fija propia, que cobraría lo mismo a cualquiera. Fixture
    // real y no uno ZZ_QA: es justo el camino de precio que hay que probar,
    // y crear un combo de depilación de prueba implicaría armarle zonas.
    const [combo] = await testDb
      .select({ id: depilationCombo.id })
      .from(depilationCombo)
      .where(eq(depilationCombo.name, "Cuerpo Full"))
      .limit(1);
    if (!combo) throw new Error('no está seedeado el pack "Cuerpo Full" (¿corriste npm run db:up?)');
    packId = combo.id;
  });

  afterAll(async () => {
    await limpiarClientasQA();
    await pgClient.end();
  });

  it("la cotización exige customerId: sin él no puede saber en qué tarifa cobrar", async () => {
    const res = await pedirQuote({ origen: "depilacion", id: packId, sessions: 1 });
    expect(res.status).toBe(400);
  });

  it("a un hombre le cotiza el pack de depilación en su tarifa", async () => {
    const pedir = async (customerId: string) => {
      const res = await pedirQuote({ origen: "depilacion", id: packId, sessions: 1, customerId });
      expect(res.status).toBe(200);
      return (await res.json()) as { finalAmount: number };
    };
    const mujer = await pedir(idClientaMujer);
    const hombre = await pedir(idClientaHombre);
    expect(hombre.finalAmount).toBeGreaterThan(mujer.finalAmount);
  });
});
