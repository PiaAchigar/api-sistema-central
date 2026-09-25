import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { customerPurchase, customerPurchaseService, depilationCombo, promotions, service } from "../db/schema";
import type { Db } from "../db/client";
import { createCompra, cancelCompra, listComprasDeCliente } from "./compras.repo";
import { createPromotion, deletePromotionPermanently } from "./promotions.repo";
import { crearCombo, hardDeleteCombo } from "./depilacion.repo";

/**
 * Task 9 (concern del revisor): los dos `leftJoin` nuevos de
 * `listComprasDeCliente` y el tercer argumento de `nombreDeLaLinea` no
 * tenían NINGÚN test que los ejerciera de punta a punta. El revisor apagó
 * la funcionalidad (`nombreDeLaLinea(s.serviceName, respaldo, null)`) y la
 * suite entera siguió en 882/882 — nada iba a avisar si alguien rompe el
 * join, el orden del `??` o borra el tercer argumento en un refactor.
 *
 * Este archivo llama a `listComprasDeCliente` de verdad, contra la base
 * local, con un paquete de promo real (servicio + pack de depilación como
 * destinos). Es el caso donde el respaldo por cabecera NO alcanza: un
 * paquete nunca lleva `depilation_combo_id` en su propia cabecera (lo exige
 * la guarda de `createCompra` para `esPaquete`), así que si la línea del
 * pack no trajera su propia identidad, `nombreDeLaLinea` no tendría de
 * dónde sacar el nombre y la ficha volvería a mostrar "—" — el bug exacto
 * que esta tarea vino a arreglar.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_FICHA";

let clienteId: string;
let servicioId: string;
let packId: string;
let promoId: string;
let compraId: string;
let capacitacionId: string;
let compraCapacitacionId: string;

async function limpiar() {
  // Las compras primero: `cancelCompra` no borra, y una fila viva referencia
  // servicio/pack/promo QA — el DELETE de más abajo reventaría por FK si no
  // se limpia esto antes (mismo motivo documentado en
  // compras-paquete.repo.test.ts).
  const compras = await db
    .select({ id: customerPurchase.id })
    .from(customerPurchase)
    .where(like(customerPurchase.description, `${QA}%`));
  for (const c of compras) {
    await db.delete(customerPurchaseService).where(eq(customerPurchaseService.customerPurchaseId, c.id));
    await db.delete(customerPurchase).where(eq(customerPurchase.id, c.id));
  }

  const promos = await db.select({ id: promotions.id }).from(promotions).where(like(promotions.name, `${QA}%`));
  for (const p of promos) await deletePromotionPermanently(db, p.id);

  const packs = await db
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(like(depilationCombo.name, `${QA}%`));
  for (const p of packs) await hardDeleteCombo(db, p.id);

  await db.delete(service).where(like(service.name, `${QA}%`));
}

beforeAll(async () => {
  await limpiar();

  // Sin filtro ZZ_QA a propósito: ningún archivo de la suite crea clientes
  // de prueba (`grep -rl "insert(customers)"` sólo devuelve
  // `customers.repo.ts`), así que no hay fixture QA de otra suite que un
  // `limit 1` sin ORDER BY pueda agarrar acá. El resto de los `select`
  // nuevos de este archivo no lee catálogo compartido: el servicio y el
  // pack se CREAN acá mismo, con nombre QA propio.
  const [cli] = await db.execute<{ id: string }>("select id from customers limit 1" as never);
  clienteId = cli!.id;

  const [srv] = await db
    .insert(service)
    .values({ name: `${QA}_SERVICIO`, isActive: true, unitPriceList: "50000" })
    .returning({ id: service.id });
  servicioId = srv!.id;

  const pack = await crearCombo(db, {
    name: `${QA}_PACK`,
    kind: "pack_fijo",
    fixedPrice: 65000,
    zonaIds: [],
  });
  packId = pack!.id;

  const promo = await createPromotion(
    db,
    { name: QA, promotionType: "paquete", precioDelPaquete: 100000 },
    [
      { tipo: "servicio", id: servicioId, cantidad: 1 },
      { tipo: "depilacion", id: packId, cantidad: 1 },
    ],
    [],
  );
  promoId = promo!.id;

  const compra = await createCompra(db, {
    customerId: clienteId,
    esPaquete: true,
    promotionId: promoId,
    promotionName: QA,
    description: QA,
    sessionsTotal: 1,
    baseAmount: 115000,
    discountedAmount: 100000,
    finalAmount: 100000,
  });
  compraId = compra.id;

  // Una compra de CAPACITACIÓN suelta: sus líneas también llevan
  // `service_id` en NULL, igual que las de depilación. Es lo que hace falta
  // para probar que la ficha distingue una de la otra (ronda de arreglos 3,
  // Important 3).
  const [cap] = await db.execute<{ id: string }>("select id from training limit 1" as never);
  capacitacionId = cap!.id;
  const compraCap = await createCompra(db, {
    customerId: clienteId,
    trainingId: capacitacionId,
    description: `${QA}_CAPACITACION`,
    sessionsTotal: 2,
    baseAmount: 200000,
    discountedAmount: 200000,
    finalAmount: 200000,
  });
  compraCapacitacionId = compraCap.id;
});

afterAll(async () => {
  if (compraId) await cancelCompra(db, compraId, "limpieza de test");
  if (compraCapacitacionId) await cancelCompra(db, compraCapacitacionId, "limpieza de test");
  await limpiar();
  await pgClient.end();
});

describe("listComprasDeCliente — cada línea dice su propio nombre (1.55.0)", () => {
  it("la línea de un SERVICIO muestra el nombre del servicio", async () => {
    const compras = await listComprasDeCliente(db, clienteId);
    const compra = compras.find((c) => c.id === compraId);
    expect(compra).toBeDefined();

    const lineaServicio = compra!.servicios.find((s) => s.serviceId === servicioId);
    expect(lineaServicio).toBeDefined();
    expect(lineaServicio!.serviceName).toBe(`${QA}_SERVICIO`);
  });

  it("la línea de un PACK DE DEPILACIÓN dentro de un paquete muestra el nombre del pack — la cabecera del paquete no lo sabe", async () => {
    const compras = await listComprasDeCliente(db, clienteId);
    const compra = compras.find((c) => c.id === compraId);
    expect(compra).toBeDefined();

    // La cabecera de un paquete nunca lleva depilation_combo_id (lo exige
    // `createCompra` para esPaquete): si el nombre saliera de ahí, sería
    // null. Tiene que venir de la identidad PROPIA de la línea.
    const lineaPack = compra!.servicios.find((s) => s.serviceId === null);
    expect(lineaPack).toBeDefined();
    expect(lineaPack!.serviceName).toBe(`${QA}_PACK`);
  });
});

/**
 * Ronda de arreglos 3 (Important 3). La pastilla "A agendar" del CRM decidía
 * "esto es depilación" por la AUSENCIA de `serviceId` — pero las líneas de
 * CAPACITACIÓN también lo tienen en NULL. Resultado: tocarla sobre un
 * instructorado abría el modal en modo depilación, el `GET /para-agendar`
 * daba 404 y el modal quedaba en blanco, sin ningún mensaje.
 *
 * La ficha tiene que decir de qué es cada línea, no dejarlo a adivinar.
 */
describe("listComprasDeCliente — la línea dice si es de depilación", () => {
  it("la línea de un pack de depilación trae su depilationComboId", async () => {
    const compras = await listComprasDeCliente(db, clienteId);
    const compra = compras.find((c) => c.id === compraId)!;
    const lineaPack = compra.servicios.find((s) => s.serviceId === null)!;
    expect(lineaPack.depilationComboId).toBe(packId);
  });

  it("la de un servicio, no", async () => {
    const compras = await listComprasDeCliente(db, clienteId);
    const compra = compras.find((c) => c.id === compraId)!;
    const lineaServicio = compra.servicios.find((s) => s.serviceId === servicioId)!;
    expect(lineaServicio.depilationComboId).toBeNull();
  });

  it("y la de una CAPACITACIÓN tampoco, aunque tenga el serviceId en NULL igual que la depilación", async () => {
    const compras = await listComprasDeCliente(db, clienteId);
    const compra = compras.find((c) => c.id === compraCapacitacionId)!;
    expect(compra.servicios.length).toBeGreaterThan(0);
    for (const linea of compra.servicios) {
      expect(linea.serviceId).toBeNull();
      expect(linea.depilationComboId).toBeNull();
    }
  });
});
