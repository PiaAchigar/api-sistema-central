import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import { combos, comboService, customerPurchase, customerPurchaseService, promotions } from "../db/schema";
import type { Db } from "../db/client";
import {
  createPromotion,
  deletePromotionPermanently,
  getPromotionById,
  updatePromotion,
} from "./promotions.repo";
import { createCompra } from "./compras.repo";

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

describe("vender con promo — invariante de servicios agendables", () => {
  // Clienta de prueba del seed (`seed.dev.sql`), no la toca `traer-catalogo.sh`.
  const CUSTOMER_ID_DE_PRUEBA = "dddddddd-0000-0000-0000-000000000001";
  const COMBO_DE_VENTA = "ZZ_QA_PROMOTIONS_TEST_venta";

  it("vender con promo deja los mismos servicios agendables que sin promo", async () => {
    // La promo mueve el PRECIO, no lo que la clienta se lleva. Si esto se
    // rompe, la clienta paga y después no puede sacar turno.
    //
    // `comboId` (de arriba) sirve como destino de promo en el resto de la
    // suite, pero como combo de VENTA no alcanza: en local (`traer-catalogo.sh`
    // sólo trae categorías/servicios, no combos) nace sin ninguna fila en
    // `combo_service`, y `createCompra` no generaría ningún
    // `customer_purchase_service` — la invariante quedaría probada en falso
    // por no tener nada que comparar. Por eso este test arma SU PROPIO combo,
    // con un servicio real adentro.
    const [area] = await db.execute<{ id: string }>(
      "select id from categories where kind = 'area' limit 1" as never,
    );
    const [comboDeVenta] = await db
      .insert(combos)
      .values({
        name: COMBO_DE_VENTA,
        priceType: "fixed",
        fixedPrice: "1000",
        validityMonths: 1,
        isActive: true,
        areaCategoryId: area!.id,
      })
      .returning({ id: combos.id });
    const comboVentaId = comboDeVenta!.id;
    await db
      .insert(comboService)
      .values({ comboId: comboVentaId, serviceId: servicioId, sessionsIncluded: 1, servicePrice: "1000" });

    const promo = await createPromotion(db, header, [{ tipo: "combo", id: comboVentaId }], []);

    const crearCompraDePrueba = (promotionId: string | null) =>
      createCompra(db, {
        customerId: CUSTOMER_ID_DE_PRUEBA,
        comboId: comboVentaId,
        description: "Compra de prueba — invariante de promo",
        sessionsTotal: 1,
        baseAmount: 1000,
        discountedAmount: 1000,
        finalAmount: promotionId ? 800 : 1000,
        promotionId,
        promotionName: promotionId ? (promo!.name ?? null) : null,
      });

    let conPromo: Awaited<ReturnType<typeof crearCompraDePrueba>> | undefined;
    let sinPromo: Awaited<ReturnType<typeof crearCompraDePrueba>> | undefined;
    try {
      conPromo = await crearCompraDePrueba(promo!.id);
      sinPromo = await crearCompraDePrueba(null);

      const filas = (id: string) =>
        db.execute<{ n: string }>(
          `select count(*) n from customer_purchase_service
            where customer_purchase_id = '${id}' and service_id is not null` as never,
        );
      expect((await filas(conPromo.id))[0]!.n).toBe((await filas(sinPromo.id))[0]!.n);
    } finally {
      const compraIds = [conPromo?.id, sinPromo?.id].filter((id): id is string => Boolean(id));
      if (compraIds.length > 0) {
        await db
          .delete(customerPurchaseService)
          .where(inArray(customerPurchaseService.customerPurchaseId, compraIds));
        await db.delete(customerPurchase).where(inArray(customerPurchase.id, compraIds));
      }
      await deletePromotionPermanently(db, promo!.id);
      await db.delete(comboService).where(eq(comboService.comboId, comboVentaId));
      await db.delete(combos).where(eq(combos.id, comboVentaId));
    }
  });
});
