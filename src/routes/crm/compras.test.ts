import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../../db/schema";
import { contacts, customers, depilationCombo } from "../../db/schema";
import type { Db } from "../../db/client";
import type { AppBindings, Variables } from "../../env";
import { compraBody, comprasRouter } from "./compras";
import { listComprasDeCliente } from "../../repositories/compras.repo";
import { serviciosDisponiblesPara } from "../../repositories/consumo.repo";
import { usarConfigDeDepilacionDeTest } from "../../test-support/depilation-config";

// El router corre `auth` por ruta, que pisa cualquier usuario puesto antes: para
// probar con un usuario real (uuid, mail, rol) los tests mandan x-test-* y este
// doble los toma. Sin esos headers pasa la `auth` verdadera (API key, admin).
vi.mock("../../middleware/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../middleware/auth")>();
  return {
    ...real,
    auth: async (c: any, next: any) => {
      const rol = c.req.header("x-test-rol");
      if (!rol) return real.auth(c, next);
      c.set("userId", c.req.header("x-test-uid") ?? null);
      c.set("userRole", rol);
      c.set("userEmail", c.req.header("x-test-email") ?? null);
      return next();
    },
  };
});

// La config de depilación la edita Laura: el archivo arma la suya (ver test-support).
usarConfigDeDepilacionDeTest();

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

  describe("precio de lista o efectivo (1.66.0)", () => {
    const PROMO = "22222222-2222-2222-2222-222222222222";

    it("quote con promo y precio lista → 400 'Las promos se cobran sólo en efectivo.'", async () => {
      const res = await pedirQuote({
        origen: "depilacion", id: packId, sessions: 1, customerId: idClientaMujer,
        promotionId: PROMO, precio: "lista",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Las promos se cobran sólo en efectivo.");
    });

    it("POST con promo y precio lista → 400", async () => {
      const res = await app.request(
        "/purchases",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            customerId: idClientaMujer, depilationComboId: packId, description: "x", sessionsTotal: 1,
            baseAmount: 1000, discountedAmount: 1000, finalAmount: 900, promotionId: PROMO, precio: "lista",
          }),
        },
        ENV,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Las promos se cobran sólo en efectivo.");
    });

    it("POST guarda price_mode", async () => {
      const res = await app.request(
        "/purchases",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            customerId: idClientaMujer, depilationComboId: packId, description: "QA price_mode", sessionsTotal: 1,
            baseAmount: 1000, discountedAmount: 1000, finalAmount: 1000, precio: "efectivo",
          }),
        },
        ENV,
      );
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const [fila] = await testDb
        .select({ priceMode: schema.customerPurchase.priceMode })
        .from(schema.customerPurchase)
        .where(eq(schema.customerPurchase.id, id));
      expect(fila?.priceMode).toBe("efectivo");
      // La lista de compras de la clienta también tiene que devolverlo (lo lee el CRM).
      const lista = await listComprasDeCliente(testDb, idClientaMujer);
      expect(lista.find((x) => x.id === id)?.priceMode).toBe("efectivo");
      // Se borra la compra de prueba (la clienta se limpia en afterAll).
      await testDb.delete(schema.customerPurchase).where(eq(schema.customerPurchase.id, id));
    });
  });

  describe("POST /purchases/:id/postpone (1.66.0)", () => {
    const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const VENCE = new Date("2099-01-10T12:00:00Z");
    const PASADA = new Date("2020-01-10T12:00:00Z");

    const compras: string[] = [];
    afterAll(async () => {
      for (const id of compras) {
        await testDb.delete(schema.customerPurchaseService).where(eq(schema.customerPurchaseService.customerPurchaseId, id));
        await testDb.delete(schema.customerPurchase).where(eq(schema.customerPurchase.id, id));
      }
    });

    async function nuevaCompra(customerId: string, expiresAt: Date | null) {
      const [f] = await testDb
        .insert(schema.customerPurchase)
        .values({
          customerId, depilationComboId: packId, description: "QA aplazo", sessionsTotal: 1,
          baseAmount: "1000", discountedAmount: "1000", finalAmount: "1000",
          purchasedAt: new Date(), expiresAt,
        })
        .returning({ id: schema.customerPurchase.id });
      compras.push(f!.id);
      return f!.id;
    }

    const comoSales = { "x-test-rol": "sales", "x-test-uid": UID, "x-test-email": "laura@piubella.test" };
    // `accountant` no tiene crm.manage: el requirePermission es el real.
    const comoContadora = { "x-test-rol": "accountant", "x-test-uid": UID };
    const postergar = (quien: Record<string, string>, id: string, body: unknown) =>
      app.request(
        `/purchases/${id}/postpone`,
        { method: "POST", headers: { "Content-Type": "application/json", ...quien }, body: JSON.stringify(body) },
        ENV,
      );

    it("postpone mueve expires_at y registra el aplazo con quién", async () => {
      const id = await nuevaCompra(idClientaMujer, VENCE);
      const res = await postergar(comoSales, id, { nuevaFecha: "2099-03-01T12:00:00Z", motivo: "estuvo internada" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { expiresAt: string }).expiresAt).toBe("2099-03-01T12:00:00.000Z");

      const [c] = await testDb.select({ e: schema.customerPurchase.expiresAt }).from(schema.customerPurchase).where(eq(schema.customerPurchase.id, id));
      expect(c!.e!.toISOString()).toBe("2099-03-01T12:00:00.000Z");

      const filas = await testDb.select().from(schema.purchaseExpiryPostponements).where(eq(schema.purchaseExpiryPostponements.purchaseId, id));
      expect(filas).toHaveLength(1);
      expect(filas[0]!.previousExpiresAt.toISOString()).toBe(VENCE.toISOString());
      expect(filas[0]!.reason).toBe("estuvo internada");
      expect(filas[0]!.userId).toBe(UID);
      expect(filas[0]!.userEmail).toBe("laura@piubella.test");
    });

    it("una fecha aaaa-mm-dd vence a fin de ESE día en Argentina, no el día anterior", async () => {
      const id = await nuevaCompra(idClientaMujer, VENCE);
      const res = await postergar(comoSales, id, { nuevaFecha: "2099-12-15" });
      expect(res.status).toBe(200);
      const [c] = await testDb.select({ e: schema.customerPurchase.expiresAt }).from(schema.customerPurchase).where(eq(schema.customerPurchase.id, id));
      // 15/12 23:59:59 en Argentina (UTC-3) = 16/12 02:59:59 UTC.
      expect(c!.e!.toISOString()).toBe("2099-12-16T02:59:59.000Z");
      const enAr = c!.e!.toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
      expect(enAr).toBe("2099-12-15");
    });

    it("dos aplazos quedan los dos en aplazos[]", async () => {
      const id = await nuevaCompra(idClientaMujer, VENCE);
      expect((await postergar(comoSales, id, { nuevaFecha: "2099-03-01T12:00:00Z" })).status).toBe(200);
      expect((await postergar(comoSales, id, { nuevaFecha: "2099-06-01T12:00:00Z", motivo: "otra vez" })).status).toBe(200);

      const lista = await listComprasDeCliente(testDb, idClientaMujer);
      const mia = lista.find((x) => x.id === id)!;
      expect(mia.aplazos).toHaveLength(2);
      expect(mia.aplazos[0]!.hasta).toBe("2099-03-01T12:00:00.000Z");
      expect(mia.aplazos[1]!.desde).toBe("2099-03-01T12:00:00.000Z");
      expect(mia.aplazos[1]!.hasta).toBe("2099-06-01T12:00:00.000Z");
      expect(mia.aplazos[1]!.motivo).toBe("otra vez");
      expect(mia.aplazos[1]!.quien).toBe("laura@piubella.test");
    });

    it("postpone sin permiso manage → 403", async () => {
      const id = await nuevaCompra(idClientaMujer, VENCE);
      const res = await postergar(comoContadora, id, { nuevaFecha: "2099-03-01T12:00:00Z" });
      expect(res.status).toBe(403);
    });

    it("una fecha que no corre para adelante → 400 con el motivo", async () => {
      const id = await nuevaCompra(idClientaMujer, VENCE);
      const res = await postergar(comoSales, id, { nuevaFecha: "2098-01-01T12:00:00Z" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "Aplazar es correr la fecha para adelante. Esta compra ya vence el 10/01/2099.",
      );
    });

    it("la compra aplazada vuelve a ser consumible", async () => {
      const [svc] = await testDb.select({ id: schema.service.id }).from(schema.service).limit(1);
      const id = await nuevaCompra(idClientaMujer, PASADA);
      await testDb.insert(schema.customerPurchaseService).values({ customerPurchaseId: id, serviceId: svc!.id, repeticion: 1, orden: 1 });

      const ahora = new Date();
      expect((await serviciosDisponiblesPara(testDb, idClientaMujer, svc!.id, ahora)).some((x) => x.purchaseId === id)).toBe(false);

      const res = await postergar(comoSales, id, { nuevaFecha: "2099-03-01T12:00:00Z" });
      expect(res.status).toBe(200);
      expect((await serviciosDisponiblesPara(testDb, idClientaMujer, svc!.id, ahora)).some((x) => x.purchaseId === id)).toBe(true);
    });
  });
});
