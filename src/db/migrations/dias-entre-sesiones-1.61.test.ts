import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import type { AppBindings, Variables } from "../../env";
// @ts-ignore -- el proyecto no incluye @types/node (solo workers-types); vitest corre en Node
import { execSync } from "node:child_process";

// Las rutas de administración piden sesión: se reemplaza `auth` por uno que toma el rol de x-rol.
vi.mock("../../middleware/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../middleware/auth")>();
  return {
    ...real,
    auth: async (c: any, next: any) => {
      const rol = c.req.header("x-rol") ?? null;
      c.set("userId", rol ? "u-test" : null);
      c.set("userRole", rol);
      await next();
    },
  };
});

const { combosRouter } = await import("../../routes/agenda/combos");
const { promotionsRouter } = await import("../../routes/agenda/promotions");
const { depilacionRouter } = await import("../../routes/agenda/depilacion");

/**
 * Migración 1.61.0 (días entre sesiones) y las APIs de Administración que la
 * guardan y la devuelven. Cada test arma sus propios datos (prefijo ZZ_QA_PLAN).
 */
const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const sql = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const ENV = { HYPERDRIVE: { connectionString: URL_DB } } as unknown as AppBindings;

const QA = "ZZ_QA_PLAN";
const ARCHIVO = "src/db/migrations/1.61.0/01-dias-entre-sesiones.sql";
const TABLAS = ["combos", "promotions", "depilation_combo", "depilation_pricing_config"] as const;

function aplicarMigracion() {
  execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${ARCHIVO}"`,
    { stdio: "pipe" },
  );
}

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.route("/combos", combosRouter);
app.route("/promos", promotionsRouter);
app.route("/depi", depilacionRouter);

const llamar = (method: string, url: string, body?: unknown) =>
  app.request(
    url,
    {
      method,
      headers: { "Content-Type": "application/json", "x-rol": "admin" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV,
  );

let areaId = "";
let servicioId = "";
let proveedoraId = "";
let zonaId = "";
let diasOriginalConfig: number | null = null;

async function limpiar() {
  await sql`DELETE FROM promotion_target WHERE promotion_id IN (SELECT id FROM promotions WHERE name LIKE ${QA + "%"})`;
  await sql`DELETE FROM promotion_service WHERE promotion_id IN (SELECT id FROM promotions WHERE name LIKE ${QA + "%"})`;
  await sql`DELETE FROM promotions WHERE name LIKE ${QA + "%"}`;
  await sql`DELETE FROM combo_service WHERE combo_id IN (SELECT id FROM combos WHERE name LIKE ${QA + "%"})`;
  await sql`DELETE FROM combos WHERE name LIKE ${QA + "%"}`;
  await sql`DELETE FROM depilation_combo_zone WHERE combo_id IN (SELECT id FROM depilation_combo WHERE name LIKE ${QA + "%"})`;
  await sql`DELETE FROM depilation_combo WHERE name LIKE ${QA + "%"}`;
}

beforeAll(async () => {
  aplicarMigracion();
  await limpiar();
  areaId = (await sql`SELECT id FROM categories ORDER BY id LIMIT 1`)[0]!.id as string;
  servicioId = (await sql`SELECT id FROM service ORDER BY id LIMIT 1`)[0]!.id as string;
  proveedoraId = (await sql`SELECT id FROM service_providers ORDER BY id LIMIT 1`)[0]!.id as string;
  zonaId = (await sql`SELECT id FROM body_zone WHERE is_active ORDER BY id LIMIT 1`)[0]!.id as string;
  const [cfg] = await sql`SELECT session_interval_days FROM depilation_pricing_config WHERE singleton = true`;
  diasOriginalConfig = (cfg?.session_interval_days as number | null) ?? null;
});

afterAll(async () => {
  await limpiar();
  await sql`UPDATE depilation_pricing_config SET session_interval_days = ${diasOriginalConfig} WHERE singleton = true`;
  await sql.end();
});

describe("migración 1.61.0", () => {
  it("la 1.61.0 agrega session_interval_days a combos, promotions, depilation_combo y depilation_pricing_config, nullable", async () => {
    for (const t of TABLAS) {
      const [col] = await sql`
        SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_name = ${t} AND column_name = 'session_interval_days'`;
      expect(col, `${t} no tiene la columna`).toBeDefined();
      expect(col!.data_type).toBe("integer");
      expect(col!.is_nullable).toBe("YES");
    }
  });

  it("la 1.61.0 se puede correr dos veces", () => {
    expect(() => aplicarMigracion()).not.toThrow();
    expect(() => aplicarMigracion()).not.toThrow();
  });

  it("rechaza 0 y negativos (CHECK)", async () => {
    // Las cuatro tablas tienen el CHECK...
    for (const t of TABLAS) {
      const checks = await sql`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = ${t}::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%session_interval_days%'`;
      expect(checks, `${t} no tiene el CHECK`).toHaveLength(1);
    }
    // ...y rechaza de verdad (promotions está vacía en una base nueva: se inserta;
    // la config es singleton y siempre tiene su fila).
    for (const malo of [0, -7]) {
      await expect(
        sql`INSERT INTO promotions (id, name, session_interval_days) VALUES (gen_random_uuid(), ${QA + "_check"}, ${malo})`,
      ).rejects.toThrow(/ck_promotions_session_interval_days/);
      await expect(
        sql`UPDATE depilation_pricing_config SET session_interval_days = ${malo} WHERE singleton = true`,
      ).rejects.toThrow(/ck_dpc_session_interval_days/);
    }
  });
});

describe("APIs de Administración", () => {
  const comboBase = (extra: Record<string, unknown>) => ({
    name: `${QA}_combo`,
    priceType: "fixed",
    fixedPrice: 10000,
    validityMonths: 6,
    areaCategoryId: areaId,
    ...extra,
  });

  it("POST/PUT de combos guarda y devuelve sessionIntervalDays", async () => {
    const res = await llamar("POST", "/combos/admin", comboBase({
      kind: "combo",
      lines: [{ serviceId: servicioId }],
      sessionIntervalDays: 15,
    }));
    expect(res.status).toBe(201);
    const creado = (await res.json()) as any;
    expect(creado.sessionIntervalDays).toBe(15);

    const edit = await llamar("PATCH", `/combos/admin/${creado.id}`, comboBase({
      kind: "combo",
      lines: [{ serviceId: servicioId }],
      sessionIntervalDays: 20,
    }));
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as any).sessionIntervalDays).toBe(20);

    const lista = (await (await llamar("GET", "/combos/admin?kind=combo")).json()) as any[];
    expect(lista.find((c) => c.id === creado.id)!.sessionIntervalDays).toBe(20);

    const sinDias = await llamar("PATCH", `/combos/admin/${creado.id}`, comboBase({
      kind: "combo",
      lines: [{ serviceId: servicioId }],
      sessionIntervalDays: null,
    }));
    expect(((await sinDias.json()) as any).sessionIntervalDays).toBeNull();

    const cero = await llamar("PATCH", `/combos/admin/${creado.id}`, comboBase({
      kind: "combo",
      lines: [{ serviceId: servicioId }],
      sessionIntervalDays: 0,
    }));
    expect(cero.status).toBe(400);
  });

  it("POST de packs guarda y devuelve sessionIntervalDays", async () => {
    const res = await llamar("POST", "/combos/admin", comboBase({
      name: `${QA}_pack`,
      kind: "pack",
      packSessions: 4,
      lines: [{ serviceId: servicioId }],
      sessionIntervalDays: 10,
    }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).sessionIntervalDays).toBe(10);
  });

  it("POST/PATCH de promos guarda y devuelve sessionIntervalDays", async () => {
    const body = (extra: Record<string, unknown>) => ({
      name: `${QA}_promo`,
      promotionType: "percentage",
      discountPercentage: 10,
      destinos: [{ tipo: "servicio", id: servicioId }],
      pagos: [{ serviceId: servicioId, serviceProviderId: proveedoraId, providerPayment: 1000 }],
      ...extra,
    });
    const res = await llamar("POST", "/promos/admin", body({ sessionIntervalDays: 14 }));
    expect(res.status).toBe(201);
    const creada = (await res.json()) as any;
    expect(creada.sessionIntervalDays).toBe(14);

    const edit = await llamar("PATCH", `/promos/admin/${creada.id}`, body({ sessionIntervalDays: 28 }));
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as any).sessionIntervalDays).toBe(28);

    const lista = (await (await llamar("GET", "/promos/admin")).json()) as any[];
    expect(lista.find((p) => p.id === creada.id)!.sessionIntervalDays).toBe(28);

    const cero = await llamar("PATCH", `/promos/admin/${creada.id}`, body({ sessionIntervalDays: -1 }));
    expect(cero.status).toBe(400);
  });

  it("POST/PATCH de combos de depilación guarda y devuelve sessionIntervalDays", async () => {
    const body = (extra: Record<string, unknown>) => ({
      name: `${QA}_depi`,
      kind: "guardado",
      zonaIds: [zonaId],
      ...extra,
    });
    const res = await llamar("POST", "/depi/combos", body({ sessionIntervalDays: 25 }));
    expect(res.status).toBe(201);
    const creado = (await res.json()) as any;
    expect(creado.sessionIntervalDays).toBe(25);

    const edit = await llamar("PATCH", `/depi/combos/${creado.id}`, body({ sessionIntervalDays: 35 }));
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as any).sessionIntervalDays).toBe(35);

    const lista = (await (await llamar("GET", "/depi/combos")).json()) as any[];
    expect(lista.find((c) => c.id === creado.id)!.sessionIntervalDays).toBe(35);

    const cero = await llamar("PATCH", `/depi/combos/${creado.id}`, body({ sessionIntervalDays: 0 }));
    expect(cero.status).toBe(400);
  });

  it("PUT de la config de depilación guarda y devuelve sessionIntervalDays", async () => {
    // Una config válida armada acá (no la que Laura tenga cargada): precios
    // crecientes por tamaño y tarifas de escalón chicas, para pasar la no-inversión.
    const config = {
      priceFemaleGrande: 20000, priceFemaleMediana: 15000, priceFemaleChica: 10000,
      priceMaleGrande: 25000, priceMaleMediana: 18000, priceMaleChica: 12000,
      pricingMinutesFemaleGrande: 30, pricingMinutesFemaleMediana: 20, pricingMinutesFemaleChica: 10,
      pricingMinutesMaleGrande: 40, pricingMinutesMaleMediana: 25, pricingMinutesMaleChica: 15,
      tier1RatePerMinute: 300, tier2RatePerMinute: 200,
      slotMinutesFemaleGrande: 30, slotMinutesFemaleMediana: 20, slotMinutesFemaleChica: 10,
      slotMinutesMaleGrande: 40, slotMinutesMaleMediana: 25, slotMinutesMaleChica: 15,
      slotRoundingStep: 5, slotMinimumMinutes: 15,
      packSessions: 6, packDiscountPercentage: 20, packRoundingBase: 500,
    };
    const antes = (await sql`SELECT * FROM depilation_pricing_config WHERE singleton = true`)[0]!;
    try {
      const res = await llamar("PUT", "/depi/config", { ...config, sessionIntervalDays: 21 });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).sessionIntervalDays).toBe(21);

      const get = (await (await llamar("GET", "/depi/config")).json()) as any;
      expect(get.sessionIntervalDays).toBe(21);

      const cero = await llamar("PUT", "/depi/config", { ...config, sessionIntervalDays: 0 });
      expect(cero.status).toBe(400);
    } finally {
      // Se devuelve la config de la base a como estaba: es la de Laura.
      const { id: _id, singleton: _s, ...cols } = antes as Record<string, unknown>;
      for (const [k, v] of Object.entries(cols)) {
        await sql.unsafe(`UPDATE depilation_pricing_config SET ${k} = $1 WHERE singleton = true`, [v as any]);
      }
    }
  });
});
