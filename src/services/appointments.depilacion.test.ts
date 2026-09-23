import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointmentBodyZone,
  appointments,
  bodyZone,
  customerPurchase,
  depilationCombo,
  machines,
  serviceMachine,
  serviceProviderAvailability,
  serviceProviderMachine,
  serviceProviderService,
  serviceProviders,
} from "../db/schema";
import type { Db } from "../db/client";
import { anclaDeDepilacion } from "../repositories/ancla-de-depilacion.repo";
import { lineasDeDepilacionLibres } from "../repositories/consumo.repo";
import { createCompra } from "../repositories/compras.repo";
import { crearCombo, hardDeleteCombo } from "../repositories/depilacion.repo";
import { getAppointmentDetail } from "../repositories/appointments.repo";
import { createAppointment, rescheduleAppointment, updateAppointmentStatus } from "./appointments.service";

/**
 * Task 12: el turno de depilación se crea con las zonas ELEGIDAS, no con el
 * presupuesto entero del pack, y esas zonas sobreviven a reagendar y se
 * liberan al cancelar.
 *
 * Contra base real por el mismo motivo que `appointments.service.test.ts`:
 * la lógica cruza disponibilidad (proveedora + máquina + horario) y el
 * presupuesto de `datosParaAgendar` (Task 11), y esa clase de cruce es
 * exactamente la que se rompe en producción sin que un mock lo note.
 *
 * La base local no trae ninguna proveedora habilitada para el servicio ancla
 * (no se vende de por sí, así que nadie la cargó) ni la máquina que exige
 * `requires_machine`: las dos se arman acá como fixture.
 */

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_DEPILTURNO";
// Clienta del seed, sexo NULL en su contacto → `sexoDeLaClienta` la trata
// como "mujer". Mismo id que usa `appointments.service.test.ts`: ningún
// archivo de la suite crea clientes (ver `consumo.repo.test.ts`), así que se
// reusa la primera clienta real en vez de armar una propia.
const CUSTOMER_ID = "dddddddd-0000-0000-0000-000000000001";

let anclaId: string;
let proveedoraId: string;
let maquinaId: string;
let piernaId: string;
let axilaId: string;
let packAId: string; // presupuesta 30' — de sobra para pierna(9)+axila(3)=12
let packBId: string; // presupuesta 10' — MENOS que pierna+axila, a propósito

// Una línea libre por test, para que ninguno le coma la sesión al otro.
let lineaTurno1Id: string;
let lineaConsumeId: string;
let lineaRechazoId: string;
let lineaSinZonasId: string;

let turno1Id: string;

async function zonasDelTurno(appointmentId: string) {
  return db
    .select({ bodyZoneId: appointmentBodyZone.bodyZoneId, minutos: appointmentBodyZone.minutos })
    .from(appointmentBodyZone)
    .where(eq(appointmentBodyZone.appointmentId, appointmentId));
}

/**
 * Deja la base como si esta suite nunca hubiera corrido. Orden que respeta
 * las FK (todas NO ACTION salvo `customer_purchase_service.customer_purchase_id`,
 * que sí cascadea):
 *
 *   compras (cascadea las líneas) → turnos (cascadea sus zonas) → packs →
 *   zonas del catálogo → certificaciones/acuerdos/horario de la proveedora →
 *   máquina/proveedora.
 */
async function limpiar() {
  const compras = await db
    .select({ id: customerPurchase.id })
    .from(customerPurchase)
    .where(like(customerPurchase.description, `${QA}%`));
  if (compras.length > 0) {
    await db.delete(customerPurchase).where(
      inArray(customerPurchase.id, compras.map((c) => c.id)),
    );
  }

  // Cascada a `appointment_body_zone` (ON DELETE CASCADE, migración 1.56.0).
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));

  const packs = await db
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(like(depilationCombo.name, `${QA}%`));
  for (const p of packs) await hardDeleteCombo(db, p.id);

  await db.delete(bodyZone).where(like(bodyZone.name, `${QA}%`));

  const proveedoras = await db
    .select({ id: serviceProviders.id })
    .from(serviceProviders)
    .where(like(serviceProviders.fullName, `${QA}%`));
  const proveedoraIds = proveedoras.map((p) => p.id);
  if (proveedoraIds.length > 0) {
    await db
      .delete(serviceProviderMachine)
      .where(inArray(serviceProviderMachine.serviceProviderId, proveedoraIds));
    await db
      .delete(serviceProviderService)
      .where(inArray(serviceProviderService.serviceProviderId, proveedoraIds));
    await db
      .delete(serviceProviderAvailability)
      .where(inArray(serviceProviderAvailability.serviceProviderId, proveedoraIds));
    await db.delete(serviceProviders).where(inArray(serviceProviders.id, proveedoraIds));
  }

  const maquinas = await db
    .select({ id: machines.id })
    .from(machines)
    .where(like(machines.name, `${QA}%`));
  const maquinaIds = maquinas.map((m) => m.id);
  if (maquinaIds.length > 0) {
    await db.delete(serviceMachine).where(inArray(serviceMachine.machineId, maquinaIds));
    await db.delete(machines).where(inArray(machines.id, maquinaIds));
  }
}

beforeAll(async () => {
  await limpiar();

  anclaId = await anclaDeDepilacion(db);

  // Categorías elegidas para que, con la config de hoy (mujer: grande=9',
  // chica=3'), pierna+axila den justo 12' — el número que pide el brief.
  const [pierna] = await db
    .insert(bodyZone)
    .values({ name: `${QA}_PIERNA`, category: "grande", displayOrder: 900, isActive: true })
    .returning({ id: bodyZone.id });
  piernaId = pierna!.id;

  const [axila] = await db
    .insert(bodyZone)
    .values({ name: `${QA}_AXILA`, category: "chica", displayOrder: 901, isActive: true })
    .returning({ id: bodyZone.id });
  axilaId = axila!.id;

  // Pack A: presupuesta 30' — de sobra para pierna+axila (12').
  const packA = await crearCombo(db, {
    name: `${QA}_PACK_A`,
    kind: "pack_fijo",
    fixedPrice: 90000,
    fixedDurationMinutes: 30,
    choiceZoneCount: 0,
    zonaIds: [piernaId, axilaId],
  });
  packAId = packA!.id;

  // Pack B: mismo menú, pero presupuesta MENOS (10') que pierna+axila (12') —
  // existe sólo para el test de "rechaza pasarse del presupuesto".
  const packB = await crearCombo(db, {
    name: `${QA}_PACK_B`,
    kind: "pack_fijo",
    fixedPrice: 50000,
    fixedDurationMinutes: 10,
    choiceZoneCount: 0,
    zonaIds: [piernaId, axilaId],
  });
  packBId = packB!.id;

  // Máquina + proveedora habilitadas para el ancla: la base local no trae
  // ninguna (el ancla no se vende, así que nadie la cargó).
  const [maquina] = await db
    .insert(machines)
    .values({ name: `${QA}_MAQUINA`, status: "active" })
    .returning({ id: machines.id });
  maquinaId = maquina!.id;
  await db.insert(serviceMachine).values({
    serviceId: anclaId,
    machineId: maquinaId,
    isPrimaryMachine: true,
  });

  const [proveedora] = await db
    .insert(serviceProviders)
    .values({ fullName: `${QA}_PROVEEDORA`, status: "active" })
    .returning({ id: serviceProviders.id });
  proveedoraId = proveedora!.id;

  await db.insert(serviceProviderService).values({
    serviceProviderId: proveedoraId,
    serviceId: anclaId,
    paymentType: "fixed_per_service",
    rate: "1000",
    isActive: true,
  });
  await db.insert(serviceProviderMachine).values({
    serviceProviderId: proveedoraId,
    machineId: maquinaId,
  });
  // Lunes (day_of_week=1): las fechas de prueba (2026-10-05 y 2026-10-12)
  // caen las dos lunes, y `open_hours` del local ya abre 09–20 ese día.
  await db.insert(serviceProviderAvailability).values({
    serviceProviderId: proveedoraId,
    dayOfWeek: 1,
    workStartTime: "09:00:00",
    workEndTime: "20:00:00",
    isActive: true,
  });

  // Cuatro compras, cada una con UNA sesión libre de su pack — así cada test
  // consume la suya sin pisarle la sesión a otro.
  const comprar = (sufijo: string, comboId: string) =>
    createCompra(db, {
      customerId: CUSTOMER_ID,
      depilationComboId: comboId,
      description: `${QA}_COMPRA_${sufijo}`,
      sessionsTotal: 1,
      baseAmount: 90000,
      discountedAmount: 90000,
      finalAmount: 90000,
    });

  const compraTurno1 = await comprar("TURNO1", packAId);
  const compraConsume = await comprar("CONSUME", packAId);
  const compraRechazo = await comprar("RECHAZO", packBId);
  const compraSinZonas = await comprar("SINZONAS", packAId);

  const libres = await lineasDeDepilacionLibres(db, CUSTOMER_ID, new Date());
  lineaTurno1Id = libres.find((l) => l.purchaseId === compraTurno1.id)!.purchaseServiceId;
  lineaConsumeId = libres.find((l) => l.purchaseId === compraConsume.id)!.purchaseServiceId;
  lineaRechazoId = libres.find((l) => l.purchaseId === compraRechazo.id)!.purchaseServiceId;
  lineaSinZonasId = libres.find((l) => l.purchaseId === compraSinZonas.id)!.purchaseServiceId;
}, 30000);

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("crear un turno de depilación", () => {
  it("dura los minutos de las zonas elegidas, no el presupuesto entero", async () => {
    const turno = await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: anclaId,
      providerId: proveedoraId,
      start: "2026-10-05T13:00:00.000Z",
      customerPurchaseServiceId: lineaTurno1Id,
      zonas: [piernaId, axilaId],
      notes: QA,
    });
    turno1Id = turno.id;
    expect(turno.durationMinutes).toBe(12);
  });

  it("guarda qué zonas se hicieron, con sus minutos congelados", async () => {
    const zonas = await zonasDelTurno(turno1Id);
    expect(zonas.map((z) => z.bodyZoneId).sort()).toEqual([axilaId, piernaId].sort());
    expect(zonas.find((z) => z.bodyZoneId === piernaId)!.minutos).toBe(9);
    expect(zonas.find((z) => z.bodyZoneId === axilaId)!.minutos).toBe(3);
  });

  /**
   * Ronda de arreglos 1: el detalle de UN turno (`GET /:id`, lo que alimenta
   * el recibo) también tiene que traer las zonas — sin esto, abrir un turno
   * de depilación no dice qué se depiló.
   */
  it("el detalle del turno trae las zonas elegidas", async () => {
    const detalle = await getAppointmentDetail(db, turno1Id);
    expect(detalle).not.toBeNull();
    expect(detalle!.zonas.map((z) => z.bodyZoneId).sort()).toEqual([axilaId, piernaId].sort());
    expect(detalle!.zonas.find((z) => z.bodyZoneId === piernaId)!.minutos).toBe(9);
  });

  it("consume la línea comprada: esa sesión deja de estar libre", async () => {
    const antes = await lineasDeDepilacionLibres(db, CUSTOMER_ID, new Date());
    expect(antes.some((l) => l.purchaseServiceId === lineaConsumeId)).toBe(true);

    await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: anclaId,
      providerId: proveedoraId,
      // Otro horario del mismo día: no puede pisar al turno del test anterior.
      start: "2026-10-05T15:00:00.000Z",
      customerPurchaseServiceId: lineaConsumeId,
      zonas: [axilaId],
      notes: QA,
    });

    const despues = await lineasDeDepilacionLibres(db, CUSTOMER_ID, new Date());
    expect(despues.some((l) => l.purchaseServiceId === lineaConsumeId)).toBe(false);
  });

  it("rechaza elegir más minutos que el presupuesto", async () => {
    await expect(
      createAppointment(db, {
        customerId: CUSTOMER_ID,
        serviceId: anclaId,
        providerId: proveedoraId,
        start: "2026-10-05T17:00:00.000Z",
        customerPurchaseServiceId: lineaRechazoId,
        // Pack B presupuesta 10'; pierna+axila piden 12'.
        zonas: [piernaId, axilaId],
      }),
    ).rejects.toThrow(/presupuesto|no entra/i);
  });

  it("un turno de depilación sin zonas no se crea", async () => {
    await expect(
      createAppointment(db, {
        customerId: CUSTOMER_ID,
        serviceId: anclaId,
        providerId: proveedoraId,
        start: "2026-10-05T18:00:00.000Z",
        customerPurchaseServiceId: lineaSinZonasId,
        zonas: [],
      }),
    ).rejects.toThrow(/al menos una zona/i);
  });

  /**
   * Review Focus #1: el campo `zonas` sólo tiene sentido con el servicio
   * ancla. Mandarlo con cualquier otro servicio tiene que ser un error, no
   * algo que se ignore en silencio — si no, un bug en el front que mande
   * zonas de más pasaría desapercibido en un turno normal.
   */
  it("un turno que no es de depilación no acepta zonas", async () => {
    await expect(
      createAppointment(db, {
        customerId: CUSTOMER_ID,
        // Cualquier id que no sea el ancla alcanza: el rechazo es anterior a
        // resolver si el servicio existe.
        serviceId: "11111111-1111-1111-1111-111111111111",
        providerId: proveedoraId,
        start: "2026-10-05T19:00:00.000Z",
        zonas: [axilaId],
      }),
    ).rejects.toThrow(/depilación/i);
  });

  /**
   * Review Focus #5. Reagendar mueve el turno de hora; las zonas son QUÉ se
   * hace, no cuándo. Si se perdieran, el recibo quedaría sin detalle y la
   * trazabilidad —que es la mitad de por qué existe esta tabla— se borraría
   * cada vez que una clienta cambia el día.
   */
  it("reagendar conserva las zonas del turno", async () => {
    await rescheduleAppointment(db, turno1Id, "2026-10-12T13:00:00.000Z");
    const zonas = await zonasDelTurno(turno1Id);
    expect(zonas).toHaveLength(2);
  });

  /**
   * Review Focus #5, la otra mitad. Cancelar tiene que devolver la sesión al
   * pozo: la clienta avisó y la va a reagendar. La condición de "línea libre"
   * ya trata un turno `cancelled` como liberado — este test es el que impide
   * que alguien la rompa sin enterarse.
   */
  it("cancelar el turno vuelve a liberar la sesión comprada", async () => {
    await updateAppointmentStatus(db, turno1Id, { status: "cancelled" });
    const libres = await lineasDeDepilacionLibres(db, CUSTOMER_ID, new Date());
    expect(libres.find((l) => l.purchaseServiceId === lineaTurno1Id)).toBeDefined();
  });
});
