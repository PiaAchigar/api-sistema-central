import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointments,
  customerPurchase,
  customerPurchaseService,
  depilationCombo,
  promotions,
  service,
} from "../db/schema";
import type { Db } from "../db/client";
import { fechasCrudas } from "../lib/parametros-de-consulta";
import {
  condicionDeLineaDeDepilacionLibre,
  condicionDeServicioLibre,
  lineasDeDepilacionLibres,
} from "./consumo.repo";
import { cancelCompra, createCompra } from "./compras.repo";
import { createPromotion, deletePromotionPermanently } from "./promotions.repo";
import { crearCombo, hardDeleteCombo } from "./depilacion.repo";

/**
 * Las consultas que se revisan de cerca antes de que salgan a producción.
 *
 * Acá ningún test toca una base —es la regla de la casa— así que una consulta
 * mal parametrizada pasaría verde y rompería recién contra Postgres. Esta
 * lista es la red: sumar una consulta es agregarle una entrada.
 *
 * El porqué de "ningún Date" está en `lib/parametros-de-consulta.ts`.
 */
const db = drizzle(postgres("postgresql://sin:conexion@127.0.0.1:1/vacio"), { schema });

const CONSULTAS: Record<string, () => { params: readonly unknown[] }> = {
  "qué tiene la clienta a favor para este servicio": () =>
    db
      .select()
      .from(schema.customerPurchaseService)
      .where(
        condicionDeServicioLibre(
          "11111111-1111-1111-1111-111111111111",
          "22222222-2222-2222-2222-222222222222",
          new Date("2026-09-16T01:00:00.000Z"),
        ),
      )
      .toSQL(),
  "las sesiones de depilación libres de la clienta": () =>
    db
      .select()
      .from(schema.customerPurchaseService)
      .where(
        condicionDeLineaDeDepilacionLibre(
          "11111111-1111-1111-1111-111111111111",
          new Date("2026-09-16T01:00:00.000Z"),
        ),
      )
      .toSQL(),
};

describe("ningún parámetro sale como Date", () => {
  for (const [nombre, armar] of Object.entries(CONSULTAS)) {
    it(nombre, () => {
      expect(fechasCrudas(armar())).toEqual([]);
    });
  }
});

/**
 * Task 10: `lineasDeDepilacionLibres` contra la base local de verdad.
 *
 * Cuatro compras de depilación para la misma clienta real (la primera de
 * `customers`, siguiendo el mismo criterio que `compras-ficha.repo.test.ts`:
 * ningún archivo de la suite crea clientes, así que no hay fixture QA ajeno
 * que un `limit 1` pueda agarrar acá):
 *
 *   - `compraDe3Id`   — 3 sesiones sueltas, ninguna agendada. El caso base.
 *   - `compraVencidaId` — 1 sesión, pero la compra ya venció.
 *   - `compraCanceladaId` — 1 sesión, compra cancelada.
 *   - `compraPaqueteId` — el caso que justifica la tarea: el pack de
 *     depilación vendido ADENTRO de un paquete de promo. Su cabecera tiene
 *     los cuatro orígenes en NULL (`ck_cpu_origen_unico`, 1.55.0); si la
 *     consulta buscara la identidad ahí, esta sesión sería invisible.
 *
 * Los `.filter(purchaseId === …)` en vez de indexar `libres[0]` a secas: la
 * suite es no determinista (fixtures `ZZ_QA%` de otros archivos corriendo en
 * paralelo contra la misma clienta compartida), así que sólo lo que filtra
 * por el id de ESTA compra es un assert estable.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const dbReal = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_DEPILIBRE";

let idClienta: string;
let packPiernaId: string;
let servicioId: string;
let promoId: string;
let compraDe3Id: string;
let compraVencidaId: string;
let compraCanceladaId: string;
let compraPaqueteId: string;

async function limpiar() {
  // Las compras primero: `cancelCompra` no borra, y una fila viva referencia
  // el pack/servicio/promo QA — el DELETE de más abajo reventaría por FK si
  // no se limpia esto antes (mismo motivo documentado en
  // compras-ficha.repo.test.ts).
  const compras = await dbReal
    .select({ id: customerPurchase.id })
    .from(customerPurchase)
    .where(like(customerPurchase.description, `${QA}%`));
  for (const c of compras) {
    await dbReal
      .delete(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, c.id));
    await dbReal.delete(customerPurchase).where(eq(customerPurchase.id, c.id));
  }

  const promos = await dbReal
    .select({ id: promotions.id })
    .from(promotions)
    .where(like(promotions.name, `${QA}%`));
  for (const p of promos) await deletePromotionPermanently(dbReal, p.id);

  const packs = await dbReal
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(like(depilationCombo.name, `${QA}%`));
  for (const p of packs) await hardDeleteCombo(dbReal, p.id);

  await dbReal.delete(service).where(like(service.name, `${QA}%`));

  // Los turnos de prueba no tienen un nombre QA propio en ninguna columna
  // indexable por like salvo `notes`, que se setea a propósito al crearlos.
  await dbReal.delete(appointments).where(like(appointments.notes, `${QA}%`));
}

beforeAll(async () => {
  await limpiar();

  // Sin filtro ZZ_QA a propósito, igual que compras-ficha.repo.test.ts:
  // ningún archivo de la suite crea clientes, así que no hay fixture QA de
  // otra suite que un `limit 1` sin ORDER BY pueda agarrar acá.
  const [cli] = await dbReal.execute<{ id: string }>("select id from customers limit 1" as never);
  idClienta = cli!.id;

  const pack = await crearCombo(dbReal, {
    name: `${QA}_PACK_PIERNA`,
    kind: "pack_fijo",
    fixedPrice: 90000,
    zonaIds: [],
  });
  packPiernaId = pack!.id;

  const [srv] = await dbReal
    .insert(service)
    .values({ name: `${QA}_SERVICIO`, isActive: true, unitPriceList: "130000" })
    .returning({ id: service.id });
  servicioId = srv!.id;

  // Compra normal, 3 sesiones sueltas: la línea hereda el `depilation_combo_id`
  // de la cabecera al vender (ver `createCompra`), como funcionaba antes de
  // que existiera un paquete de promo.
  const compraDe3 = await createCompra(dbReal, {
    customerId: idClienta,
    depilationComboId: packPiernaId,
    description: `${QA}_3_SESIONES`,
    sessionsTotal: 3,
    baseAmount: 270000,
    discountedAmount: 270000,
    finalAmount: 270000,
  });
  compraDe3Id = compraDe3.id;

  // Vencida ayer: `condicionDeLineaDeDepilacionLibre` la tiene que dejar
  // afuera aunque la sesión en sí esté sin usar.
  const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const compraVencida = await createCompra(dbReal, {
    customerId: idClienta,
    depilationComboId: packPiernaId,
    description: `${QA}_VENCIDA`,
    sessionsTotal: 1,
    baseAmount: 90000,
    discountedAmount: 90000,
    finalAmount: 90000,
    expiresAt: ayer,
  });
  compraVencidaId = compraVencida.id;

  // Cancelada: `cancelCompra` no borra nada, pone `cancelled_at`.
  const compraCancelada = await createCompra(dbReal, {
    customerId: idClienta,
    depilationComboId: packPiernaId,
    description: `${QA}_CANCELADA`,
    sessionsTotal: 1,
    baseAmount: 90000,
    discountedAmount: 90000,
    finalAmount: 90000,
  });
  compraCanceladaId = compraCancelada.id;
  await cancelCompra(dbReal, compraCanceladaId, "limpieza de test");

  // El caso que justifica la tarea: un paquete de promo con el pack de
  // depilación adentro, junto a un servicio — como "Promo Novia: combo + 3
  // limpiezas + un pack de piernas". La cabecera de esta compra sale con los
  // cuatro orígenes en NULL (`esPaquete: true` lo exige); la identidad de
  // cada línea vive únicamente en `customer_purchase_service`.
  const promo = await createPromotion(
    dbReal,
    { name: QA, promotionType: "paquete", precioDelPaquete: 200000 },
    [
      { tipo: "servicio", id: servicioId, cantidad: 1 },
      { tipo: "depilacion", id: packPiernaId, cantidad: 1 },
    ],
    [],
  );
  promoId = promo!.id;

  const compraPaquete = await createCompra(dbReal, {
    customerId: idClienta,
    esPaquete: true,
    promotionId: promoId,
    promotionName: QA,
    description: `${QA}_PAQUETE`,
    sessionsTotal: 1,
    baseAmount: 220000,
    discountedAmount: 200000,
    finalAmount: 200000,
  });
  compraPaqueteId = compraPaquete.id;
}, 30000);

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("lineasDeDepilacionLibres", () => {
  it("encuentra las sesiones compradas que todavía no se agendaron", async () => {
    const libres = await lineasDeDepilacionLibres(dbReal, idClienta, new Date());
    const deLaCompra = libres.filter((l) => l.purchaseId === compraDe3Id);
    expect(deLaCompra).toHaveLength(3);
    expect(deLaCompra[0]!.nombreDelPack).toBe(`${QA}_PACK_PIERNA`);
  });

  it("una sesión ya agendada deja de estar libre", async () => {
    const antes = await lineasDeDepilacionLibres(dbReal, idClienta, new Date());
    const primera = antes
      .filter((l) => l.purchaseId === compraDe3Id)
      .find((l) => l.repeticion === 1);
    expect(primera).toBeDefined();

    // No se usa `tomarServicio`: exige un `serviceId`, y una línea de
    // depilación lo tiene en NULL — ese camino de escritura es de otra
    // tarea. Acá alcanza con simular "ya tiene un turno vivo enganchado".
    const [turno] = await dbReal
      .insert(appointments)
      .values({ status: "scheduled", notes: QA })
      .returning({ id: appointments.id });
    await dbReal
      .update(customerPurchaseService)
      .set({ appointmentId: turno!.id })
      .where(eq(customerPurchaseService.id, primera!.purchaseServiceId));

    const libres = await lineasDeDepilacionLibres(dbReal, idClienta, new Date());
    expect(libres.filter((l) => l.purchaseId === compraDe3Id)).toHaveLength(2);
  });

  it("una compra vencida no ofrece nada", async () => {
    const libres = await lineasDeDepilacionLibres(dbReal, idClienta, new Date());
    expect(libres.find((l) => l.purchaseId === compraVencidaId)).toBeUndefined();
  });

  it("una compra cancelada tampoco", async () => {
    const libres = await lineasDeDepilacionLibres(dbReal, idClienta, new Date());
    expect(libres.find((l) => l.purchaseId === compraCanceladaId)).toBeUndefined();
  });

  /**
   * Review Focus #4. En un paquete de promo la cabecera de la compra tiene los
   * CUATRO orígenes en NULL (lo exige `ck_cpu_origen_unico` desde la 1.55.0):
   * quién es la línea vive en la LÍNEA. Una consulta que buscara la identidad
   * en la cabecera no encontraría nunca las sesiones de un paquete, y Laura
   * las vería en la ficha sin poder agendarlas.
   */
  it("encuentra también la depilación que vino adentro de un paquete de promo", async () => {
    const libres = await lineasDeDepilacionLibres(dbReal, idClienta, new Date());
    const dePaquete = libres.find((l) => l.purchaseId === compraPaqueteId);
    expect(dePaquete).toBeDefined();
    expect(dePaquete!.esPaquete).toBe(true);
    expect(dePaquete!.depilationComboId).toBe(packPiernaId);
  });
});
