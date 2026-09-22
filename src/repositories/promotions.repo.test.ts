import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointments,
  combos,
  comboService,
  customerPurchase,
  customerPurchaseService,
  promotions,
  promotionService,
  promotionTarget,
} from "../db/schema";
import type { Db } from "../db/client";
import {
  createPromotion,
  deletePromotionPermanently,
  getPromotionById,
  getPromotionDeleteImpact,
  listActivePromotions,
  updatePromotion,
} from "./promotions.repo";
import { cancelCompra, createCompra } from "./compras.repo";
import { getComboDeleteImpact } from "./combos.repo";
import { listPromosVendibles, motivoPromoNoVendible, obtenerPromoVendible } from "./catalogo-venta.repo";

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
    "select id from service where is_active = true and name not like 'ZZ_QA%' order by id limit 1" as never,
  );
  const [p] = await db.execute<{ id: string }>(
    "select id from service_providers where full_name not like 'ZZ_QA%' or full_name is null order by id limit 1" as never,
  );
  // Sólo sirve un combo REAL del catálogo, no un QA que haya quedado de
  // OTRO archivo — `limpiar()` de acá arriba sólo conoce y borra el propio
  // (`ZZ_QA_PROMOTIONS_TEST_combo`). Corriendo la suite entera en paralelo,
  // esto agarró de verdad un combo QA de `compras-paquete.repo.test.ts`
  // (creado y borrado por ese archivo durante su propia corrida) y reventó
  // acá más tarde por FK cuando ya no existía. `ZZ_QA%` es la convención de
  // prefijo que usa TODA la suite para nombrar fixtures de test — excluirlos
  // a todos, no sólo al propio, es lo que hace falta para no ser un test
  // "de cualquier combo que haya".
  const [c] = await db.execute<{ id: string }>(
    "select id from combos where name not like 'ZZ_QA%' order by id limit 1" as never,
  );
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
      "select id from categories where kind = 'area' and name not like 'ZZ_QA%' order by id limit 1" as never,
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

  it("guarda el precio del paquete y la cantidad de cada destino", async () => {
    const creada = await createPromotion(
      db,
      { ...header, promotionType: "paquete", precioDelPaquete: 250000 },
      [{ tipo: "servicio", id: servicioId, cantidad: 3 }],
      [],
    );
    expect(creada!.precioDelPaquete).toBe(250000);
    expect(creada!.destinos[0]).toMatchObject({ id: servicioId, cantidad: 3 });
  });

  it("en una promo de DESCUENTO la cantidad se fuerza a 1", async () => {
    // "20% off sobre 3 limpiezas" no quiere decir nada: el descuento se aplica
    // a lo que la clienta elija, de a uno.
    const creada = await createPromotion(
      db,
      { ...header, promotionType: "percentage", discountPercentage: 20 },
      [{ tipo: "servicio", id: servicioId, cantidad: 3 }],
      [],
    );
    expect(creada!.destinos[0]!.cantidad).toBe(1);
  });

  it("una promo de paquete SIN precio no se guarda", async () => {
    await expect(
      createPromotion(db, { ...header, promotionType: "paquete" }, [{ tipo: "servicio", id: servicioId }], []),
    ).rejects.toThrow(/precio/i);
  });

  it("una promo de paquete SIN nada adentro no se guarda", async () => {
    await expect(
      createPromotion(db, { ...header, promotionType: "paquete", precioDelPaquete: 1000 }, [], []),
    ).rejects.toThrow(/al menos una/i);
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

describe("listActivePromotions — lo que ve la web pública", () => {
  it("una promo con is_visible_web en false no sale por el endpoint público", async () => {
    const creada = await createPromotion(
      db,
      { ...header, isVisibleWeb: false },
      [{ tipo: "servicio", id: servicioId }],
      [],
    );
    const activas = await listActivePromotions(db);
    expect(activas.find((p) => p.id === creada!.id)).toBeUndefined();
  });

  it("una promo con is_visible_web en true sale, con sus destinos", async () => {
    const creada = await createPromotion(
      db,
      { ...header, isVisibleWeb: true },
      [{ tipo: "servicio", id: servicioId }],
      [],
    );
    const activas = await listActivePromotions(db);
    const encontrada = activas.find((p) => p.id === creada!.id);
    expect(encontrada).toBeTruthy();
    expect(encontrada!.targets).toHaveLength(1);
    expect(encontrada!.targets[0]).toMatchObject({ tipo: "servicio", id: servicioId });
  });

  it("featured:true no devuelve una promo destacada pero sin publicar", async () => {
    // is_featured sigue significando "aparece además en el carrusel de la
    // home": la home muestra un subconjunto de lo publicado, nunca algo sin
    // publicar. Si esto se rompe, una promo que Laura marcó destacada por
    // error (sin tildar publicar) se cuela en la home igual.
    const creada = await createPromotion(
      db,
      { ...header, isVisibleWeb: false, isFeatured: true },
      [{ tipo: "servicio", id: servicioId }],
      [],
    );
    const destacadas = await listActivePromotions(db, { featured: true });
    expect(destacadas.find((p) => p.id === creada!.id)).toBeUndefined();
  });

  it("featured:true sí devuelve una promo destacada Y publicada", async () => {
    const creada = await createPromotion(
      db,
      { ...header, isVisibleWeb: true, isFeatured: true },
      [{ tipo: "servicio", id: servicioId }],
      [],
    );
    const destacadas = await listActivePromotions(db, { featured: true });
    expect(destacadas.find((p) => p.id === creada!.id)).toBeTruthy();
  });
});

// Clienta de prueba del seed (`seed.dev.sql`), no la toca `traer-catalogo.sh`.
const CUSTOMER_ID_DE_PRUEBA = "dddddddd-0000-0000-0000-000000000001";

/** Una venta de un servicio suelto, con o sin promo. Devuelve el id para
 *  poder borrarla en el `finally`: `limpiar()` borra promos, no ventas, y con
 *  la FK en ON DELETE SET NULL una venta olvidada sobrevive muda. */
async function venderServicio(promotionId: string | null, promotionName: string | null) {
  const compra = await createCompra(db, {
    customerId: CUSTOMER_ID_DE_PRUEBA,
    serviceId: servicioId,
    description: "Venta de prueba — cupo de promo",
    sessionsTotal: 1,
    baseAmount: 1000,
    discountedAmount: 1000,
    finalAmount: promotionId ? 800 : 1000,
    promotionId,
    promotionName,
  });
  return compra.id;
}

async function borrarVentas(ids: string[]) {
  if (ids.length === 0) return;
  await db
    .delete(customerPurchaseService)
    .where(inArray(customerPurchaseService.customerPurchaseId, ids));
  await db.delete(customerPurchase).where(inArray(customerPurchase.id, ids));
}

describe("el límite de usos (spec §10)", () => {
  it("se agota a la N-ésima venta y se libera al cancelar una", async () => {
    // El cupo se cuenta EN VIVO sobre las ventas no canceladas, no con un
    // contador: por eso cancelar devuelve el uso. Es el COUNT que decide
    // cuántas veces se regala un descuento — si se desincroniza, Laura regala
    // de más y no se entera.
    const promo = await createPromotion(
      db,
      { ...header, usageLimit: 2 },
      [{ tipo: "servicio", id: servicioId }],
      [],
    );
    const ventas: string[] = [];
    try {
      expect(await obtenerPromoVendible(db, promo!.id)).toBeTruthy();

      ventas.push(await venderServicio(promo!.id, promo!.name));
      // Con 1 de 2 usada todavía se ofrece: el cupo se agota AL llegar al
      // límite, no antes.
      expect(await obtenerPromoVendible(db, promo!.id)).toBeTruthy();

      ventas.push(await venderServicio(promo!.id, promo!.name));
      expect(await obtenerPromoVendible(db, promo!.id)).toBeNull();
      // Y el motivo dice "agotada", no "no está vigente": las fechas están
      // perfectas y mandar a Laura a mirarlas la deja sin entender nada.
      expect(await motivoPromoNoVendible(db, promo!.id)).toMatch(/agot/i);

      await cancelCompra(db, ventas[1]!, "Cancelada por el test de cupo");
      expect(await obtenerPromoVendible(db, promo!.id)).toBeTruthy();
    } finally {
      await borrarVentas(ventas);
      await deletePromotionPermanently(db, promo!.id);
    }
  });

  it("sin límite cargado la promo no se agota nunca", async () => {
    const promo = await createPromotion(
      db,
      { ...header, usageLimit: null },
      [{ tipo: "servicio", id: servicioId }],
      [],
    );
    const ventas: string[] = [];
    try {
      ventas.push(await venderServicio(promo!.id, promo!.name));
      ventas.push(await venderServicio(promo!.id, promo!.name));
      expect(await obtenerPromoVendible(db, promo!.id)).toBeTruthy();
    } finally {
      await borrarVentas(ventas);
      await deletePromotionPermanently(db, promo!.id);
    }
  });
});

describe("deletePromotionPermanently", () => {
  it("el nombre de la promo sobrevive al borrado de la promo (spec §10)", async () => {
    // La venta cuenta su propia historia: la FK es ON DELETE SET NULL y el
    // nombre quedó congelado al vender. Si esto se rompe, borrar una promo
    // deja ventas viejas sin poder explicar qué descuento se les hizo.
    const promo = await createPromotion(
      db,
      header,
      [{ tipo: "servicio", id: servicioId }],
      [],
    );
    const ventaId = await venderServicio(promo!.id, promo!.name);
    try {
      await deletePromotionPermanently(db, promo!.id);

      const [fila] = await db
        .select({
          promotionId: customerPurchase.promotionId,
          promotionName: customerPurchase.promotionName,
        })
        .from(customerPurchase)
        .where(eq(customerPurchase.id, ventaId));

      expect(fila!.promotionId).toBeNull();
      expect(fila!.promotionName).toBe(NOMBRE_PROMO_DE_PRUEBA);
    } finally {
      await borrarVentas([ventaId]);
    }
  });

  it("deja en cero las DOS listas de la promo", async () => {
    // Destinos y pagos viven en tablas distintas con FKs NO ACTION: si una de
    // las dos quedara, el DELETE de la promo reventaría por constraint.
    const promo = await createPromotion(
      db,
      header,
      [
        { tipo: "servicio", id: servicioId },
        { tipo: "combo", id: comboId },
      ],
      [{ serviceId: servicioId, serviceProviderId: proveedoraId, providerPayment: 5000 }],
    );
    expect(promo!.destinos).toHaveLength(2);
    expect(promo!.pagos).toHaveLength(1);

    expect(await deletePromotionPermanently(db, promo!.id)).toBe(true);

    const destinos = await db
      .select({ id: promotionTarget.id })
      .from(promotionTarget)
      .where(eq(promotionTarget.promotionId, promo!.id));
    const pagos = await db
      .select({ id: promotionService.id })
      .from(promotionService)
      .where(eq(promotionService.promotionId, promo!.id));

    expect(destinos).toEqual([]);
    expect(pagos).toEqual([]);
    expect(await getPromotionById(db, promo!.id)).toBeNull();
  });
});

describe("getPromotionDeleteImpact — qué se lleva puesto borrar la promo", () => {
  it("cuenta las ventas que quedan desenganchadas y los pagos que se borran", async () => {
    const promo = await createPromotion(
      db,
      header,
      [{ tipo: "servicio", id: servicioId }],
      [{ serviceId: servicioId, serviceProviderId: proveedoraId, providerPayment: 5000 }],
    );
    const ventas: string[] = [];
    try {
      ventas.push(await venderServicio(promo!.id, promo!.name));

      const impacto = await getPromotionDeleteImpact(db, promo!.id);
      // Nunca bloquea: el `promotion_name` congelado sobrevive y es deliberado.
      expect(impacto.blocked).toBe(false);
      expect(impacto.cascade.ventasDesenganchadas).toBe(1);
      expect(impacto.cascade.pagosAcordados).toBe(1);
    } finally {
      await borrarVentas(ventas);
      await deletePromotionPermanently(db, promo!.id);
    }
  });

  it("cuenta los turnos todavía sin completar que hoy cobrarían el pago de la promo", async () => {
    // Es el número que más duele: esos turnos, al marcarse Realizado, van a
    // liquidarse por el acuerdo general. Un turno YA completado no cuenta —
    // congeló su `provider_earning` y borrar la promo no lo mueve.
    const promo = await createPromotion(
      db,
      header,
      [{ tipo: "servicio", id: servicioId }],
      [{ serviceId: servicioId, serviceProviderId: proveedoraId, providerPayment: 5000 }],
    );
    const ventas: string[] = [];
    let turnoId: string | undefined;
    try {
      const ventaId = await venderServicio(promo!.id, promo!.name);
      ventas.push(ventaId);

      const [turno] = await db
        .insert(appointments)
        .values({
          serviceId: servicioId,
          serviceProviderId: proveedoraId,
          status: "scheduled",
          durationMinutes: 60,
        })
        .returning({ id: appointments.id });
      turnoId = turno!.id;

      await db
        .update(customerPurchaseService)
        .set({ appointmentId: turnoId })
        .where(eq(customerPurchaseService.customerPurchaseId, ventaId));

      const conTurno = await getPromotionDeleteImpact(db, promo!.id);
      expect(conTurno.cascade.turnosAfectados).toBe(1);

      // Ya cobrado: sale de la cuenta.
      await db
        .update(appointments)
        .set({ status: "completed" })
        .where(eq(appointments.id, turnoId));
      const yaCobrado = await getPromotionDeleteImpact(db, promo!.id);
      expect(yaCobrado.cascade.turnosAfectados).toBe(0);
    } finally {
      await borrarVentas(ventas);
      if (turnoId) await db.delete(appointments).where(eq(appointments.id, turnoId));
      await deletePromotionPermanently(db, promo!.id);
    }
  });

  it("sin pago acordado para esa proveedora, el turno no cuenta", async () => {
    // El match es (promo, servicio, proveedora), igual que
    // computeProviderEarning: si el pago no existe, ese turno ya se cobraba
    // por el acuerdo general y borrar la promo no le cambia nada.
    const promo = await createPromotion(
      db,
      header,
      [{ tipo: "servicio", id: servicioId }],
      [],
    );
    const ventas: string[] = [];
    let turnoId: string | undefined;
    try {
      const ventaId = await venderServicio(promo!.id, promo!.name);
      ventas.push(ventaId);
      const [turno] = await db
        .insert(appointments)
        .values({
          serviceId: servicioId,
          serviceProviderId: proveedoraId,
          status: "scheduled",
          durationMinutes: 60,
        })
        .returning({ id: appointments.id });
      turnoId = turno!.id;
      await db
        .update(customerPurchaseService)
        .set({ appointmentId: turnoId })
        .where(eq(customerPurchaseService.customerPurchaseId, ventaId));

      const impacto = await getPromotionDeleteImpact(db, promo!.id);
      expect(impacto.cascade.pagosAcordados).toBe(0);
      expect(impacto.cascade.turnosAfectados).toBe(0);
    } finally {
      await borrarVentas(ventas);
      if (turnoId) await db.delete(appointments).where(eq(appointments.id, turnoId));
      await deletePromotionPermanently(db, promo!.id);
    }
  });
});

describe("getPromotionDeleteImpact — paquetes vendidos", () => {
  it("cuenta cuántos paquetes se vendieron con esa promo", async () => {
    // No bloquea nunca: la compra se sostiene sola con `promotion_name`
    // congelado. Pero Laura tiene que saber qué está por desenganchar.
    const creada = await createPromotion(
      db,
      { ...header, promotionType: "paquete", precioDelPaquete: 1000 },
      [{ tipo: "servicio", id: servicioId }],
      [],
    );
    const impacto = await getPromotionDeleteImpact(db, creada!.id);
    expect(impacto.blocked).toBe(false);
    expect(impacto.cascade.paquetesVendidos).toBe(0);
  });
});

describe("getComboDeleteImpact — el combo que está en oferta", () => {
  /** Un combo propio, sin compras: así el impacto no queda bloqueado por datos
   *  del catálogo real y el contador de ofertas arranca en cero. */
  async function comboDePrueba() {
    const [area] = await db.execute<{ id: string }>(
      "select id from categories where kind = 'area' and name not like 'ZZ_QA%' order by id limit 1" as never,
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
    return creado!.id;
  }

  it("cuenta las promos que lo tienen en oferta", async () => {
    // El borrado ya limpia `promotion_target`, así que el DELETE funciona. Sin
    // este número el cartel dice que no hay nada colgando y la promo pierde su
    // destino en silencio — si era el único, queda viva pero inerte.
    const id = await comboDePrueba();
    const promo = await createPromotion(db, header, [{ tipo: "combo", id }], []);
    try {
      const impacto = await getComboDeleteImpact(db, id);
      expect(impacto.blocked).toBe(false);
      expect(impacto.cascade.promoTargets).toBe(1);
    } finally {
      await deletePromotionPermanently(db, promo!.id);
      await db.delete(combos).where(eq(combos.id, id));
    }
  });

  it("sin promos que lo apunten, el contador queda en cero", async () => {
    const id = await comboDePrueba();
    try {
      const impacto = await getComboDeleteImpact(db, id);
      expect(impacto.cascade.promoTargets).toBe(0);
      expect(impacto.blockReason).toBeUndefined();
    } finally {
      await db.delete(combos).where(eq(combos.id, id));
    }
  });
});

describe("vender con promo — invariante de servicios agendables", () => {
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
      "select id from categories where kind = 'area' and name not like 'ZZ_QA%' order by id limit 1" as never,
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
      const nConPromo = Number((await filas(conPromo.id))[0]!.n);
      const nSinPromo = Number((await filas(sinPromo.id))[0]!.n);
      // Sin esto, una regresión donde el combo se vende sin líneas (todas las
      // filas de customer_purchase_service con service_id NULL) deja los dos
      // lados en 0 y el test queda verde sin haber probado nada — que es
      // justo la regresión que existe para atrapar: la clienta paga y
      // después no puede agendar.
      expect(nConPromo).toBeGreaterThan(0);
      expect(nConPromo).toBe(nSinPromo);
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

describe("listPromosVendibles — paquetes", () => {
  it("un paquete vigente viene con su tipo, su precio y las cantidades", async () => {
    // Sin esto la solapa Promos del CRM no puede saber si mostrar un desglose
    // ("lleva 3 limpiezas") o la lista de items elegibles.
    const creada = await createPromotion(
      db,
      {
        name: NOMBRE_PROMO_DE_PRUEBA,
        promotionType: "paquete",
        precioDelPaquete: 250000,
        validFrom: null,
        validUntil: null,
      },
      [{ tipo: "servicio", id: servicioId, cantidad: 3 }],
      [],
    );

    const vendibles = await listPromosVendibles(db);
    const mia = vendibles.find((p) => p.id === creada!.id)!;
    expect(mia.promotionType).toBe("paquete");
    expect(mia.precioDelPaquete).toBe(250000);
    expect(mia.destinos[0]).toMatchObject({ tipo: "servicio", id: servicioId, cantidad: 3 });
  });
});
