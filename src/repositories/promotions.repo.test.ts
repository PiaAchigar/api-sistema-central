import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { combos, promotions } from "../db/schema";
import type { Db } from "../db/client";
import {
  createPromotion,
  deletePromotionPermanently,
  getPromotionById,
  updatePromotion,
} from "./promotions.repo";

const NOMBRE_PROMO_DE_PRUEBA = "Promo de prueba";

// Igual que categories.test.ts y depilacion.test.ts: `createDbFromUrl` no
// existe con ese nombre, así que la conexión de prueba se arma con el mismo
// patrón que usan esos dos (los únicos tests del repo que tocan la base).
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_PROMOTIONS_TEST_combo";

let servicioId: string;
let proveedoraId: string;
let comboId: string;

/** Deja la base como si esta suite nunca hubiera corrido: promos de prueba y
 *  el combo QA (si quedó de una corrida anterior que se cortó a mitad). */
async function limpiar() {
  const creadas = await db
    .select({ id: promotions.id })
    .from(promotions)
    .where(eq(promotions.name, NOMBRE_PROMO_DE_PRUEBA));
  for (const p of creadas) await deletePromotionPermanently(db, p.id);
  await db.delete(combos).where(eq(combos.name, QA));
}

beforeAll(async () => {
  await limpiar();

  const [s] = await db.execute<{ id: string }>(
    "select id from service where is_active = true limit 1" as never,
  );
  const [p] = await db.execute<{ id: string }>(
    "select id from service_providers limit 1" as never,
  );
  // Sólo sirve un combo REAL del catálogo, no el QA que puede haber quedado
  // de una corrida anterior — si lo tomara, `limpiar()` ya lo borró arriba.
  const [c] = await db.execute<{ id: string }>("select id from combos limit 1" as never);
  servicioId = s!.id;
  proveedoraId = p!.id;
  if (c?.id) {
    comboId = c.id;
  } else {
    // El catálogo local (traer-catalogo.sh) sólo trae categorías/servicios, no
    // combos: acá no hay ninguno para reusar como destino, así que se siembra
    // uno mínimo y se borra en el afterAll, igual que hace categories.test.ts
    // con sus categorías QA.
    const [area] = await db.execute<{ id: string }>(
      "select id from categories where kind = 'area' limit 1" as never,
    );
    const [creado] = await db
      .insert(combos)
      .values({
        name: QA,
        priceType: "fixed",
        fixedPrice: "1000",
        validityMonths: 1,
        isActive: true,
        areaCategoryId: area!.id,
      })
      .returning({ id: combos.id });
    comboId = creado!.id;
  }
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

const header = {
  name: NOMBRE_PROMO_DE_PRUEBA,
  promotionType: "percentage" as const,
  discountPercentage: 20,
};

describe("createPromotion", () => {
  it("guarda los destinos y los pagos por separado", async () => {
    const creada = await createPromotion(
      db,
      header,
      [{ tipo: "servicio", id: servicioId }],
      [{ serviceId: servicioId, serviceProviderId: proveedoraId, providerPayment: 5000 }],
    );
    expect(creada!.destinos).toHaveLength(1);
    expect(creada!.destinos[0]).toMatchObject({ tipo: "servicio", id: servicioId });
    expect(creada!.pagos).toHaveLength(1);
    expect(creada!.pagos[0]!.providerPayment).toBe(5000);
  });

  it("un combo se guarda como destino de tipo combo", async () => {
    const creada = await createPromotion(db, header, [{ tipo: "combo", id: comboId }], []);
    expect(creada!.destinos[0]).toMatchObject({ tipo: "combo", id: comboId });
  });

  it("los pagos son opcionales: sin ellos rige el acuerdo de siempre", async () => {
    const creada = await createPromotion(db, header, [{ tipo: "servicio", id: servicioId }], []);
    expect(creada!.pagos).toEqual([]);
  });
});

describe("updatePromotion", () => {
  it("reemplaza los destinos, no los acumula", async () => {
    const creada = await createPromotion(db, header, [{ tipo: "servicio", id: servicioId }], []);
    const actualizada = await updatePromotion(
      db,
      creada!.id,
      header,
      [{ tipo: "combo", id: comboId }],
      [],
    );
    expect(actualizada!.destinos).toHaveLength(1);
    expect(actualizada!.destinos[0]!.tipo).toBe("combo");
  });

  it("un servicio repetido en dos combos deja UN solo pago", async () => {
    // El acuerdo es con la proveedora por ese servicio, no por el combo. Lo
    // garantiza la base (uq_promotion_service_pago), no la pantalla.
    const creada = await createPromotion(
      db,
      header,
      [{ tipo: "servicio", id: servicioId }],
      [
        { serviceId: servicioId, serviceProviderId: proveedoraId, providerPayment: 5000 },
        { serviceId: servicioId, serviceProviderId: proveedoraId, providerPayment: 7000 },
      ],
    );
    expect(creada!.pagos).toHaveLength(1);
  });
});

describe("getPromotionById", () => {
  it("trae el nombre del servicio y de la proveedora de cada pago", async () => {
    // Sin los nombres, el formulario muestra uuids y Laura no entiende nada.
    const creada = await createPromotion(
      db,
      header,
      [{ tipo: "servicio", id: servicioId }],
      [{ serviceId: servicioId, serviceProviderId: proveedoraId, providerPayment: 5000 }],
    );
    const leida = await getPromotionById(db, creada!.id);
    expect(leida!.pagos[0]!.serviceName).toBeTruthy();
    expect(leida!.pagos[0]!.serviceProviderName).toBeTruthy();
  });

  it("trae el nombre de cada destino", async () => {
    const creada = await createPromotion(db, header, [{ tipo: "servicio", id: servicioId }], []);
    const leida = await getPromotionById(db, creada!.id);
    expect(leida!.destinos[0]!.nombre).toBeTruthy();
  });
});
