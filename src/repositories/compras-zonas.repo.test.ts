import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointmentBodyZone,
  appointments,
  bodyZone,
  customerPurchase,
  customerPurchaseService,
  depilationCombo,
  service,
} from "../db/schema";
import type { Db } from "../db/client";
import { createCompra, listComprasDeCliente } from "./compras.repo";
import { crearCombo, hardDeleteCombo } from "./depilacion.repo";

/**
 * La ficha de la clienta tiene que poder decir QUÉ zonas trae el pack de
 * depilación que compró y cuáles se hizo en cada turno. Este archivo llama a
 * `listComprasDeCliente` de verdad contra la base local.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_ZONAS";

let clienteId: string;
let servicioId: string;
let packId: string;
let compraPackId: string;
let compraServicioId: string;
let zonasDelPack: { id: string; name: string }[];
let zonasDelTurno: { id: string; name: string }[];

async function limpiar() {
  const compras = await db
    .select({ id: customerPurchase.id })
    .from(customerPurchase)
    .where(like(customerPurchase.description, `${QA}%`));
  for (const c of compras) {
    await db.delete(customerPurchaseService).where(eq(customerPurchaseService.customerPurchaseId, c.id));
    await db.delete(customerPurchase).where(eq(customerPurchase.id, c.id));
  }

  const turnos = await db.select({ id: appointments.id }).from(appointments).where(like(appointments.notes, `${QA}%`));
  if (turnos.length > 0) {
    const ids = turnos.map((t) => t.id);
    await db.delete(appointmentBodyZone).where(inArray(appointmentBodyZone.appointmentId, ids));
    await db.delete(appointments).where(inArray(appointments.id, ids));
  }

  const packs = await db
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(like(depilationCombo.name, `${QA}%`));
  for (const p of packs) await hardDeleteCombo(db, p.id);

  await db.delete(service).where(like(service.name, `${QA}%`));
}

beforeAll(async () => {
  await limpiar();

  const [cli] = await db.execute<{ id: string }>("select id from customers limit 1" as never);
  clienteId = cli!.id;

  // Cuatro zonas reales del catálogo, ordenadas por nombre: las dos primeras
  // son del pack y las otras dos las del turno.
  const zonas = await db
    .select({ id: bodyZone.id, name: bodyZone.name })
    .from(bodyZone)
    .where(eq(bodyZone.isActive, true))
    .orderBy(bodyZone.name)
    .limit(4);
  if (zonas.length < 4) {
    throw new Error("este fixture necesita 4 zonas activas en la base local (¿corriste ./scripts/traer-catalogo.sh?)");
  }
  zonasDelPack = zonas.slice(0, 2);
  zonasDelTurno = zonas.slice(2, 4);

  const [srv] = await db
    .insert(service)
    .values({ name: `${QA}_SERVICIO`, isActive: true, unitPriceList: "50000" })
    .returning({ id: service.id });
  servicioId = srv!.id;

  const pack = await crearCombo(db, {
    name: `${QA}_PACK`,
    kind: "pack_fijo",
    fixedPrice: 65000,
    choiceZoneCount: 1,
    zonaIds: zonasDelPack.map((z) => z.id),
  });
  packId = pack!.id;

  const compraPack = await createCompra(db, {
    customerId: clienteId,
    depilationComboId: packId,
    description: `${QA}_PACK`,
    sessionsTotal: 2,
    baseAmount: 65000,
    discountedAmount: 65000,
    finalAmount: 65000,
  });
  compraPackId = compraPack.id;

  const compraServicio = await createCompra(db, {
    customerId: clienteId,
    serviceId: servicioId,
    description: `${QA}_SERVICIO`,
    sessionsTotal: 1,
    baseAmount: 50000,
    discountedAmount: 50000,
    finalAmount: 50000,
  });
  compraServicioId = compraServicio.id;

  // Un turno con las 2 zonas del turno, colgado de la primera línea del pack.
  const [turno] = await db
    .insert(appointments)
    .values({
      customerId: clienteId,
      appointmentStart: new Date("2030-01-10T15:00:00Z"),
      appointmentEnd: new Date("2030-01-10T16:00:00Z"),
      status: "scheduled",
      notes: `${QA}_TURNO`,
    })
    .returning({ id: appointments.id });
  // Se insertan al revés del orden por nombre a propósito.
  await db.insert(appointmentBodyZone).values(
    [...zonasDelTurno].reverse().map((z) => ({ appointmentId: turno!.id, bodyZoneId: z.id, minutos: 20 })),
  );
  const lineas = await db
    .select({ id: customerPurchaseService.id })
    .from(customerPurchaseService)
    .where(eq(customerPurchaseService.customerPurchaseId, compraPackId));
  await db
    .update(customerPurchaseService)
    .set({ appointmentId: turno!.id })
    .where(eq(customerPurchaseService.id, lineas[0]!.id));
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("listComprasDeCliente — zonas del pack y del turno", () => {
  it("la compra de un pack de depilación trae sus zonas más la de elección", async () => {
    const compras = await listComprasDeCliente(db, clienteId);
    const compra = compras.find((c) => c.id === compraPackId)!;
    expect(compra.zonasDelPack).toEqual([
      ...zonasDelPack.map((z) => ({ nombre: z.name, cantidad: 1 })),
      { nombre: "Zona a elección", cantidad: 1 },
    ]);
  });

  it("la línea con turno trae las zonas de ese turno, ordenadas por nombre", async () => {
    const compras = await listComprasDeCliente(db, clienteId);
    const compra = compras.find((c) => c.id === compraPackId)!;
    const conTurno = compra.servicios.filter((s) => s.appointmentId != null);
    expect(conTurno).toHaveLength(1);
    expect(conTurno[0]!.zonasDelTurno).toEqual(zonasDelTurno.map((z) => z.name));
  });

  it("la línea sin turno trae zonasDelTurno null", async () => {
    const compras = await listComprasDeCliente(db, clienteId);
    const compra = compras.find((c) => c.id === compraPackId)!;
    const sinTurno = compra.servicios.filter((s) => s.appointmentId == null);
    expect(sinTurno.length).toBeGreaterThan(0);
    for (const l of sinTurno) expect(l.zonasDelTurno).toBeNull();
  });

  it("una compra de servicio común no trae zonas del pack ni de turno", async () => {
    const compras = await listComprasDeCliente(db, clienteId);
    const compra = compras.find((c) => c.id === compraServicioId)!;
    expect(compra.zonasDelPack).toBeNull();
    for (const l of compra.servicios) expect(l.zonasDelTurno).toBeNull();
  });
});
