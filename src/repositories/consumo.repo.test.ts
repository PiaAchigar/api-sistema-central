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

import { hermanosDelCombo } from "./consumo.repo";
import { combos, comboService } from "../db/schema";

describe("hermanosDelCombo — V3c, los combos que se hacen juntos", () => {
  const QA_COMBO = "ZZ_QA_COMBOJUNTOS";

  let idClienta: string;
  let areaId: string;
  let servAId: string;
  let servBId: string;
  let servCId: string;
  let servXId: string;
  let servYId: string;
  let servSueltoId: string;
  let comboJuntosId: string;
  let comboSeparadoId: string;
  let comboDelPackId: string;
  let packDelComboId: string;
  let packSueltoId: string;

  async function limpiarCombo() {
    const compras = await dbReal
      .select({ id: customerPurchase.id })
      .from(customerPurchase)
      .where(like(customerPurchase.description, `${QA_COMBO}%`));
    for (const c of compras) {
      await dbReal
        .delete(customerPurchaseService)
        .where(eq(customerPurchaseService.customerPurchaseId, c.id));
      await dbReal.delete(customerPurchase).where(eq(customerPurchase.id, c.id));
    }
    const combosQA = await dbReal
      .select({ id: combos.id })
      .from(combos)
      .where(like(combos.name, `${QA_COMBO}%`));
    for (const c of combosQA) {
      await dbReal.delete(comboService).where(eq(comboService.comboId, c.id));
    }
    // Los packs (apuntan a otro combo por FK) antes que los combos que apuntan.
    await dbReal.delete(combos).where(like(combos.name, `${QA_COMBO}%`));
    await dbReal.delete(service).where(like(service.name, `${QA_COMBO}%`));
    await dbReal.delete(appointments).where(like(appointments.notes, `${QA_COMBO}%`));
  }

  beforeAll(async () => {
    await limpiarCombo();

    const [cli] = await dbReal.execute<{ id: string }>(
      "select id from customers limit 1" as never,
    );
    idClienta = cli!.id;
    const [area] = await dbReal.execute<{ id: string }>(
      "select id from categories where kind = 'area' and name not like 'ZZ_QA%' order by id limit 1" as never,
    );
    areaId = area!.id;

    const servicios = await dbReal
      .insert(service)
      .values([
        { name: `${QA_COMBO}_A` },
        { name: `${QA_COMBO}_B` },
        { name: `${QA_COMBO}_C` },
        { name: `${QA_COMBO}_X` },
        { name: `${QA_COMBO}_Y` },
        { name: `${QA_COMBO}_SUELTO` },
      ])
      .returning({ id: service.id });
    // Destructuring directo tipaba cada variable `string | undefined` (TS no
    // sabe que el INSERT de 6 filas siempre `returning()`a 6) — el `!` es
    // seguro acá porque las 6 filas de arriba son fijas.
    servAId = servicios[0]!.id;
    servBId = servicios[1]!.id;
    servCId = servicios[2]!.id;
    servXId = servicios[3]!.id;
    servYId = servicios[4]!.id;
    servSueltoId = servicios[5]!.id;

    // Combo de 3 servicios, JUNTOS.
    const [comboJuntos] = await dbReal
      .insert(combos)
      .values({
        name: `${QA_COMBO}_JUNTOS`, priceType: "fixed", fixedPrice: "10000",
        validityMonths: 12, isActive: true, isVisibleWeb: false, areaCategoryId: areaId,
        kind: "combo", servicesTogether: true,
      })
      .returning({ id: combos.id });
    comboJuntosId = comboJuntos!.id;
    await dbReal.insert(comboService).values([
      { comboId: comboJuntosId, serviceId: servAId, sessionsIncluded: 1, servicePrice: "3000" },
      { comboId: comboJuntosId, serviceId: servBId, sessionsIncluded: 1, servicePrice: "3000" },
      { comboId: comboJuntosId, serviceId: servCId, sessionsIncluded: 1, servicePrice: "4000" },
    ]);

    // Combo de 2 servicios, SEPARADOS (services_together: false).
    const [comboSeparado] = await dbReal
      .insert(combos)
      .values({
        name: `${QA_COMBO}_SEPARADO`, priceType: "fixed", fixedPrice: "6000",
        validityMonths: 12, isActive: true, isVisibleWeb: false, areaCategoryId: areaId,
        kind: "combo", servicesTogether: false,
      })
      .returning({ id: combos.id });
    comboSeparadoId = comboSeparado!.id;
    await dbReal.insert(comboService).values([
      { comboId: comboSeparadoId, serviceId: servAId, sessionsIncluded: 1, servicePrice: "3000" },
      { comboId: comboSeparadoId, serviceId: servBId, sessionsIncluded: 1, servicePrice: "3000" },
    ]);

    // El combo que un PACK repite: 2 servicios, JUNTOS.
    const [comboDelPack] = await dbReal
      .insert(combos)
      .values({
        name: `${QA_COMBO}_COMBO_DEL_PACK`, priceType: "fixed", fixedPrice: "5000",
        validityMonths: 12, isActive: true, isVisibleWeb: false, areaCategoryId: areaId,
        kind: "combo", servicesTogether: true,
      })
      .returning({ id: combos.id });
    comboDelPackId = comboDelPack!.id;
    await dbReal.insert(comboService).values([
      { comboId: comboDelPackId, serviceId: servXId, sessionsIncluded: 1, servicePrice: "2500" },
      { comboId: comboDelPackId, serviceId: servYId, sessionsIncluded: 1, servicePrice: "2500" },
    ]);

    // El PACK: 4 vueltas de ese combo. `services_together` en la fila del
    // pack queda en `false` siempre (lo exige `ck_combos_pack`) — la marca
    // de verdad está en `comboDelPackId`, arriba.
    const [packDelCombo] = await dbReal
      .insert(combos)
      .values({
        name: `${QA_COMBO}_PACK_DE_COMBO`, priceType: "fixed", fixedPrice: "20000",
        validityMonths: 12, isActive: true, isVisibleWeb: false, areaCategoryId: areaId,
        kind: "pack", packOfComboId: comboDelPackId, packSessions: 4, servicesTogether: false,
      })
      .returning({ id: combos.id });
    packDelComboId = packDelCombo!.id;

    // Un PACK de un servicio SUELTO repetido (sin combo detrás): lleva su
    // propia línea en `combo_service`, y `packOfComboId` es NULL.
    const [packSuelto] = await dbReal
      .insert(combos)
      .values({
        name: `${QA_COMBO}_PACK_SUELTO`, priceType: "fixed", fixedPrice: "9000",
        validityMonths: 12, isActive: true, isVisibleWeb: false, areaCategoryId: areaId,
        kind: "pack", packOfComboId: null, packSessions: 3, servicesTogether: false,
      })
      .returning({ id: combos.id });
    packSueltoId = packSuelto!.id;
    await dbReal.insert(comboService).values({
      comboId: packSueltoId, serviceId: servSueltoId, sessionsIncluded: 1, servicePrice: "3000",
    });
  }, 30000);

  afterAll(async () => {
    await limpiarCombo();
  });

  it("combo juntos=true: el que se acaba de agendar y uno con turno de antes quedan afuera; el resto vuelve", async () => {
    const compra = await createCompra(dbReal, {
      customerId: idClienta,
      comboId: comboJuntosId,
      description: `${QA_COMBO}_C1`,
      sessionsTotal: 1,
      baseAmount: 10000,
      discountedAmount: 10000,
      finalAmount: 10000,
    });
    const filas = await dbReal
      .select({ id: customerPurchaseService.id, serviceId: customerPurchaseService.serviceId })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
    const filaA = filas.find((f) => f.serviceId === servAId)!;
    const filaB = filas.find((f) => f.serviceId === servBId)!;
    const filaC = filas.find((f) => f.serviceId === servCId)!;

    // servB ya tenía turno de ANTES (no relacionado con lo que se acaba de
    // confirmar). servA es el que se acaba de agendar: se marca también, tal
    // como lo deja `tomarServicio` en la misma transacción de creación.
    const [turnoB] = await dbReal
      .insert(appointments)
      .values({ status: "scheduled", notes: `${QA_COMBO}_B` })
      .returning({ id: appointments.id });
    const [turnoA] = await dbReal
      .insert(appointments)
      .values({ status: "scheduled", notes: `${QA_COMBO}_A` })
      .returning({ id: appointments.id });
    await dbReal
      .update(customerPurchaseService)
      .set({ appointmentId: turnoB!.id })
      .where(eq(customerPurchaseService.id, filaB.id));
    await dbReal
      .update(customerPurchaseService)
      .set({ appointmentId: turnoA!.id })
      .where(eq(customerPurchaseService.id, filaA.id));

    const hermanos = await hermanosDelCombo(dbReal, filaA.id);

    expect(hermanos).toHaveLength(1);
    expect(hermanos[0]!.purchaseServiceId).toBe(filaC.id);
    expect(hermanos[0]!.serviceId).toBe(servCId);
    expect(hermanos[0]!.serviceName).toBe(`${QA_COMBO}_C`);
  });

  it("combo juntos=false: no sugiere nada", async () => {
    const compra = await createCompra(dbReal, {
      customerId: idClienta,
      comboId: comboSeparadoId,
      description: `${QA_COMBO}_C2`,
      sessionsTotal: 1,
      baseAmount: 6000,
      discountedAmount: 6000,
      finalAmount: 6000,
    });
    const [fila] = await dbReal
      .select({ id: customerPurchaseService.id })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id))
      .limit(1);

    expect(await hermanosDelCombo(dbReal, fila!.id)).toEqual([]);
  });

  // Hallazgo de la revisión final de la rama: "libre" en este archivo
  // incluye "turno cancelado" (`condicionDeServicioLibre`, reglas §3.8:
  // cancelar ANTES del horario no consume la sesión). `hermanosDelCombo`
  // sólo miraba `appointmentId IS NULL`, así que un hermano cuyo turno se
  // canceló no volvía a aparecer como sugerible, aunque SÍ se puede
  // agendar de nuevo (nada en el código pone `appointment_id` en NULL al
  // cancelar — el turno queda ahí con `status: "cancelled"`).
  it("un hermano con turno CANCELADO sigue apareciendo — cancelar no lo deja tomado", async () => {
    const compra = await createCompra(dbReal, {
      customerId: idClienta,
      comboId: comboJuntosId,
      description: `${QA_COMBO}_C6`,
      sessionsTotal: 1,
      baseAmount: 10000,
      discountedAmount: 10000,
      finalAmount: 10000,
    });
    const filas = await dbReal
      .select({ id: customerPurchaseService.id, serviceId: customerPurchaseService.serviceId })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
    const filaA = filas.find((f) => f.serviceId === servAId)!;
    const filaB = filas.find((f) => f.serviceId === servBId)!;
    const filaC = filas.find((f) => f.serviceId === servCId)!;

    // servB tuvo un turno que se CANCELÓ (no "de antes" sin relación: se
    // canceló y por eso Laura vuelve a agendar el combo). servA es el que
    // se acaba de confirmar ahora.
    const [turnoB] = await dbReal
      .insert(appointments)
      .values({ status: "cancelled", notes: `${QA_COMBO}_B_CANCELADO` })
      .returning({ id: appointments.id });
    const [turnoA] = await dbReal
      .insert(appointments)
      .values({ status: "scheduled", notes: `${QA_COMBO}_A` })
      .returning({ id: appointments.id });
    await dbReal
      .update(customerPurchaseService)
      .set({ appointmentId: turnoB!.id })
      .where(eq(customerPurchaseService.id, filaB.id));
    await dbReal
      .update(customerPurchaseService)
      .set({ appointmentId: turnoA!.id })
      .where(eq(customerPurchaseService.id, filaA.id));

    const hermanos = await hermanosDelCombo(dbReal, filaA.id);

    // servB (cancelado) y servC (nunca agendado) tienen que volver los dos.
    expect(hermanos.map((h) => h.purchaseServiceId).sort()).toEqual(
      [filaB.id, filaC.id].sort(),
    );
  });

  it("una compra sin combo (servicio suelto) no sugiere nada", async () => {
    const compra = await createCompra(dbReal, {
      customerId: idClienta,
      serviceId: servSueltoId,
      description: `${QA_COMBO}_C3`,
      sessionsTotal: 1,
      baseAmount: 3000,
      discountedAmount: 3000,
      finalAmount: 3000,
    });
    const [fila] = await dbReal
      .select({ id: customerPurchaseService.id })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id))
      .limit(1);

    expect(await hermanosDelCombo(dbReal, fila!.id)).toEqual([]);
  });

  it("pack de un combo juntos=true, 4 repeticiones: sólo trae el hermano de la MISMA repetición", async () => {
    const compra = await createCompra(dbReal, {
      customerId: idClienta,
      comboId: packDelComboId,
      description: `${QA_COMBO}_C4`,
      sessionsTotal: 4,
      baseAmount: 20000,
      discountedAmount: 20000,
      finalAmount: 20000,
    });
    const filas = await dbReal
      .select({
        id: customerPurchaseService.id,
        serviceId: customerPurchaseService.serviceId,
        repeticion: customerPurchaseService.repeticion,
      })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id));
    expect(filas).toHaveLength(8); // 4 repeticiones × 2 servicios

    const filaXRep2 = filas.find((f) => f.serviceId === servXId && f.repeticion === 2)!;
    const filaYRep2 = filas.find((f) => f.serviceId === servYId && f.repeticion === 2)!;

    const hermanos = await hermanosDelCombo(dbReal, filaXRep2.id);

    expect(hermanos).toHaveLength(1);
    expect(hermanos[0]!.purchaseServiceId).toBe(filaYRep2.id);
  });

  it("pack de un servicio suelto repetido (sin combo detrás) no sugiere nada", async () => {
    const compra = await createCompra(dbReal, {
      customerId: idClienta,
      comboId: packSueltoId,
      description: `${QA_COMBO}_C5`,
      sessionsTotal: 3,
      baseAmount: 9000,
      discountedAmount: 9000,
      finalAmount: 9000,
    });
    const [fila] = await dbReal
      .select({ id: customerPurchaseService.id })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, compra.id))
      .limit(1);

    expect(await hermanosDelCombo(dbReal, fila!.id)).toEqual([]);
  });

  it("un purchaseServiceId que no existe no tira, devuelve vacío", async () => {
    expect(
      await hermanosDelCombo(dbReal, "00000000-0000-0000-0000-000000000000"),
    ).toEqual([]);
  });
});
