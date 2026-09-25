import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray, like, ne } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointmentBodyZone,
  appointments,
  bodyZone,
  customerPurchase,
  depilationCombo,
  machines,
  payments,
  service,
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
 *
 * Task 13 (puerta de pago): las compras de este archivo se registran con su
 * pago CONFIRMADO completo (`payments`, ver `comprar`) para que los tests de
 * Task 12 —que no son sobre plata— sigan agendando sin chocar con la puerta.
 * La compra `IMPAGA`, sin pago, es la única a propósito: existe para probar
 * que el servidor la rechaza.
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
let servicioNormalId: string; // cualquier servicio real que NO sea el ancla
let proveedoraId: string;
let maquinaId: string;
let piernaId: string;
let axilaId: string;
let packAId: string; // presupuesta 30' — de sobra para pierna(9)+axila(3)=12
let packBId: string; // presupuesta 10' — MENOS que pierna+axila, a propósito
let packCId: string; // presupuesta 40' — para el turno de MÁS de 30'
let zonasGrandesIds: string[]; // 4 zonas grande (9' c/u para "mujer") = 36'

// Una línea libre por test, para que ninguno le coma la sesión al otro.
let lineaTurno1Id: string;
let lineaConsumeId: string;
let lineaRechazoId: string;
let lineaSinZonasId: string;
let lineaGrandeId: string;
let lineaImpagaId: string;

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
    const compraIds = compras.map((c) => c.id);
    // `payments.customer_purchase_id` NO cascadea (FK sin ON DELETE): borrar
    // la compra con un pago colgando revienta la FK. Se borra antes.
    await db.delete(payments).where(inArray(payments.customerPurchaseId, compraIds));
    await db.delete(customerPurchase).where(inArray(customerPurchase.id, compraIds));
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

  const [normal] = await db
    .select({ id: service.id })
    .from(service)
    .where(ne(service.id, anclaId))
    .limit(1);
  servicioNormalId = normal!.id;

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

  // Pack C: 4 zonas "grande" (9' c/u para "mujer") = 36' — MÁS que el valor
  // de relleno del ancla (30', `service.estimated_duration_minutes`,
  // migración 1.56.0). Existe sólo para el caso que más plata cuesta: un
  // turno de depilación reagendado no se puede "encoger" a ese relleno.
  zonasGrandesIds = [];
  for (let i = 1; i <= 4; i++) {
    const [z] = await db
      .insert(bodyZone)
      .values({ name: `${QA}_GRANDE_${i}`, category: "grande", displayOrder: 910 + i, isActive: true })
      .returning({ id: bodyZone.id });
    zonasGrandesIds.push(z!.id);
  }
  const packC = await crearCombo(db, {
    name: `${QA}_PACK_C`,
    kind: "pack_fijo",
    fixedPrice: 150000,
    fixedDurationMinutes: 40,
    choiceZoneCount: 0,
    zonaIds: zonasGrandesIds,
  });
  packCId = packC!.id;

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

  // Cinco compras, cada una con UNA sesión libre de su pack — así cada test
  // consume la suya sin pisarle la sesión a otro.
  //
  // Task 13: se pagan ENTERAS y CONFIRMADAS al comprar. Estos tests son de
  // Task 12 (zonas, duración, reagendado) y no de plata — sin el pago, la
  // puerta de pago los rechazaría a todos con "se paga entero" (compra de
  // UNA sola sesión).
  const comprar = async (sufijo: string, comboId: string) => {
    const compra = await createCompra(db, {
      customerId: CUSTOMER_ID,
      depilationComboId: comboId,
      description: `${QA}_COMPRA_${sufijo}`,
      sessionsTotal: 1,
      baseAmount: 90000,
      discountedAmount: 90000,
      finalAmount: 90000,
    });
    const ahora = new Date();
    await db.insert(payments).values({
      customerId: CUSTOMER_ID,
      customerPurchaseId: compra.id,
      amount: "90000",
      paymentMethod: "cash",
      status: "confirmed",
      paymentDate: ahora,
      isDeclared: true,
      confirmedAt: ahora,
    });
    return compra;
  };

  const compraTurno1 = await comprar("TURNO1", packAId);
  const compraConsume = await comprar("CONSUME", packAId);
  const compraRechazo = await comprar("RECHAZO", packBId);
  const compraSinZonas = await comprar("SINZONAS", packAId);
  const compraGrande = await comprar("GRANDE", packCId);

  // La única compra A PROPÓSITO sin pago: existe para probar la puerta.
  const compraImpaga = await createCompra(db, {
    customerId: CUSTOMER_ID,
    depilationComboId: packAId,
    description: `${QA}_COMPRA_IMPAGA`,
    sessionsTotal: 1,
    baseAmount: 90000,
    discountedAmount: 90000,
    finalAmount: 90000,
  });

  const libres = await lineasDeDepilacionLibres(db, CUSTOMER_ID, new Date());
  lineaTurno1Id = libres.find((l) => l.purchaseId === compraTurno1.id)!.purchaseServiceId;
  lineaConsumeId = libres.find((l) => l.purchaseId === compraConsume.id)!.purchaseServiceId;
  lineaRechazoId = libres.find((l) => l.purchaseId === compraRechazo.id)!.purchaseServiceId;
  lineaSinZonasId = libres.find((l) => l.purchaseId === compraSinZonas.id)!.purchaseServiceId;
  lineaGrandeId = libres.find((l) => l.purchaseId === compraGrande.id)!.purchaseServiceId;
  lineaImpagaId = libres.find((l) => l.purchaseId === compraImpaga.id)!.purchaseServiceId;
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
   *
   * Ronda de arreglos 2 (Critical): antes de este arreglo,
   * `rescheduleAppointment` recalculaba la duración desde
   * `service.estimated_duration_minutes` del ancla (30', un valor de
   * relleno de la migración 1.56.0) en vez de conservar la que el turno ya
   * tenía. Contar filas de zonas no lo agarraba —las filas sobrevivían
   * igual, sólo quedaban desincronizadas con el bloque real—, así que ahora
   * también se verifica `durationMinutes` (no cambia) y `appointmentEnd`
   * (consistente con el nuevo inicio).
   */
  it("reagendar conserva las zonas y la duración del turno", async () => {
    const reagendado = await rescheduleAppointment(db, turno1Id, "2026-10-12T13:00:00.000Z");
    expect(reagendado).not.toBeNull();
    expect(reagendado!.durationMinutes).toBe(12);
    expect(reagendado!.appointmentEnd).toEqual(new Date("2026-10-12T13:12:00.000Z"));

    const zonas = await zonasDelTurno(turno1Id);
    expect(zonas).toHaveLength(2);
  });

  /**
   * Ronda de arreglos 2, el caso que más plata cuesta: un turno de MÁS de
   * 30' (el valor de relleno del ancla). Si el bug siguiera vivo, reagendar
   * lo encogería a 30' y liberaría 6' que la clienta pagó y va a ocupar —acá
   * son 36', pero con un pack más grande la agenda dejaría entrar a otra
   * persona encima de tiempo comprometido.
   */
  it("reagendar un turno de más de 30' no lo encoge al valor de relleno del ancla", async () => {
    const turno = await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: anclaId,
      providerId: proveedoraId,
      start: "2026-10-05T20:00:00.000Z",
      customerPurchaseServiceId: lineaGrandeId,
      zonas: zonasGrandesIds,
      notes: QA,
    });
    expect(turno.durationMinutes).toBe(36);

    const reagendado = await rescheduleAppointment(db, turno.id, "2026-10-12T20:00:00.000Z");
    expect(reagendado).not.toBeNull();
    expect(reagendado!.durationMinutes).toBe(36);
    expect(reagendado!.appointmentEnd).toEqual(new Date("2026-10-12T20:36:00.000Z"));
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

  /**
   * Task 13 — la puerta de pago. `lineaImpagaId` es una compra de UNA sola
   * sesión sin ningún pago: "se paga entero" por los dos caminos (es la
   * primera Y la última). El servidor la vuelve a evaluar acá — no se confía
   * en la pantalla: entre que Laura abrió el modal y apretó Vender, otra
   * pestaña pudo haber devuelto plata.
   */
  it("el servidor no confía en la pantalla: sin pagar, rechaza el turno", async () => {
    await expect(
      createAppointment(db, {
        customerId: CUSTOMER_ID,
        serviceId: anclaId,
        providerId: proveedoraId,
        start: "2026-10-05T22:00:00.000Z",
        customerPurchaseServiceId: lineaImpagaId,
        zonas: [piernaId, axilaId],
        status: "scheduled",
        notes: QA,
      }),
    ).rejects.toThrow(/se paga entero/i);
  });

  // Reservar guarda el lugar 24 h y no cobra nada: la guarda de pago aplica
  // a AGENDAR, no a reservar. Misma línea impaga del test anterior — el
  // rechazo de arriba no llegó a tomarla.
  it("pero la reserva de 24 h pasa igual", async () => {
    const reserva = await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: anclaId,
      providerId: proveedoraId,
      start: "2026-10-05T22:00:00.000Z",
      customerPurchaseServiceId: lineaImpagaId,
      zonas: [piernaId, axilaId],
      status: "reserved",
      expiryMinutes: 1440,
      notes: QA,
    });
    expect(reserva.status).toBe("reserved");
  });
});

/**
 * Ronda de arreglos 1 (Critical). `createAppointment` sólo evalúa la puerta
 * al CREAR el turno — pero una reserva de depilación se vuelve turno real
 * por otros dos caminos que pasan por `updateAppointmentStatus`, no por ahí:
 * "Confirmar reserva" (reserved → scheduled, front `DayViewPage.tsx`) y
 * "Realizado" apretado directo sobre una reserva (reserved → completed, sin
 * pasar por scheduled). Los dos dejaban confirmar sin haber cobrado un peso.
 */
describe("puerta de pago al confirmar una reserva (Task 13, ronda 1)", () => {
  it("confirmar una reserva de depilación sin pagar se rechaza, con motivo y monto — y con el pago correcto sí", async () => {
    const compra = await createCompra(db, {
      customerId: CUSTOMER_ID,
      depilationComboId: packAId,
      description: `${QA}_COMPRA_RESERVA_IMPAGA`,
      sessionsTotal: 1,
      baseAmount: 90000,
      discountedAmount: 90000,
      finalAmount: 90000,
    });
    const libres = await lineasDeDepilacionLibres(db, CUSTOMER_ID, new Date());
    const lineaId = libres.find((l) => l.purchaseId === compra.id)!.purchaseServiceId;

    // Se reserva sin pagar nada — regla que sigue intacta.
    const reserva = await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: anclaId,
      providerId: proveedoraId,
      start: "2026-10-12T15:00:00.000Z",
      customerPurchaseServiceId: lineaId,
      zonas: [piernaId, axilaId],
      status: "reserved",
      expiryMinutes: 1440,
      notes: QA,
    });
    expect(reserva.status).toBe("reserved");

    // "Confirmar reserva" (reserved → scheduled) sin haber pagado: rechazado,
    // con el motivo Y el monto — mismo texto que en `createAppointment`.
    await expect(
      updateAppointmentStatus(db, reserva.id, { status: "scheduled" }),
    ).rejects.toThrow(/se paga entero.*falta \$90000/i);

    // Se cobra lo que corresponde (compra de una sola sesión: el 100%).
    const ahora = new Date();
    await db.insert(payments).values({
      customerId: CUSTOMER_ID,
      customerPurchaseId: compra.id,
      amount: "90000",
      paymentMethod: "cash",
      status: "confirmed",
      paymentDate: ahora,
      isDeclared: true,
      confirmedAt: ahora,
    });

    // Con el pago al día, la MISMA confirmación pasa.
    const confirmado = await updateAppointmentStatus(db, reserva.id, { status: "scheduled" });
    expect(confirmado!.status).toBe("scheduled");
    // Se limpia la fecha de expiración, como cualquier confirmación normal.
    expect(confirmado!.reservationExpiresAt).toBeNull();
  });

  /**
   * La parte que no puede romperse: la puerta es de depilación, no de la
   * agenda entera. Un turno reservado de cualquier otro servicio se confirma
   * igual que siempre, sin que nadie le pida un pago que esa compra nunca
   * exigió. Se arma con un INSERT directo (no `createAppointment`) porque acá
   * lo que se prueba es `updateAppointmentStatus` aislado, no el flujo de
   * disponibilidad de un servicio cualquiera del catálogo.
   */
  it("un turno que no es de depilación se sigue confirmando igual, sin pasar por la puerta", async () => {
    const [creada] = await db
      .insert(appointments)
      .values({
        customerId: CUSTOMER_ID,
        serviceProviderId: proveedoraId,
        serviceId: servicioNormalId,
        appointmentStart: new Date("2026-10-12T17:00:00.000Z"),
        appointmentEnd: new Date("2026-10-12T17:30:00.000Z"),
        durationMinutes: 30,
        servicePrice: "1000",
        status: "reserved",
        notes: QA,
      })
      .returning({ id: appointments.id });

    const confirmado = await updateAppointmentStatus(db, creada!.id, { status: "scheduled" });
    expect(confirmado!.status).toBe("scheduled");
  });

  /**
   * El segundo agujero que encontró el coordinador: el botón "Realizado"
   * aparece para cualquier estado que no sea completado, incluido reservado
   * — se puede saltar de `reserved` a `completed` sin pasar nunca por
   * `scheduled`. Marcar "realizado" algo que nunca se cobró es tan malo como
   * confirmarlo sin cobrar, así que `completed` pasa por la MISMA puerta.
   */
  it("'Realizado' directo sobre una reserva sin pagar (saltando scheduled) también se rechaza", async () => {
    const compra = await createCompra(db, {
      customerId: CUSTOMER_ID,
      depilationComboId: packAId,
      description: `${QA}_COMPRA_RESERVA_IMPAGA_2`,
      sessionsTotal: 1,
      baseAmount: 90000,
      discountedAmount: 90000,
      finalAmount: 90000,
    });
    const libres = await lineasDeDepilacionLibres(db, CUSTOMER_ID, new Date());
    const lineaId = libres.find((l) => l.purchaseId === compra.id)!.purchaseServiceId;

    const reserva = await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: anclaId,
      providerId: proveedoraId,
      start: "2026-10-12T18:00:00.000Z",
      customerPurchaseServiceId: lineaId,
      zonas: [piernaId, axilaId],
      status: "reserved",
      expiryMinutes: 1440,
      notes: QA,
    });

    await expect(
      updateAppointmentStatus(db, reserva.id, { status: "completed" }),
    ).rejects.toThrow(/se paga entero.*falta \$90000/i);
  });
});

/**
 * Ronda de arreglos 3 (Critical 2). `GET /para-agendar/:id?sexo=` respeta el
 * override y la pantalla dibuja el menú con ESOS minutos, pero `POST
 * /appointments` no aceptaba `sexo` y `createAppointment` volvía a llamar a
 * `datosParaAgendar` sin él: el servidor recalculaba con el sexo de la ficha
 * (o "mujer" si está en NULL, que es el caso normal — la columna es nueva y
 * los contactos viejos están sin clasificar).
 *
 * Resultado: la pantalla decía 15 min y la base guardaba 12. La agenda dejaba
 * entrar a la clienta siguiente sobre 3 minutos comprometidos y los minutos
 * congelados —que existen para que un turno viejo no cambie— quedaban
 * congelados mal. Es el problema de §3.2 que esta rama existe para arreglar,
 * sólo que en silencio.
 */
describe("el sexo elegido al agendar (ronda 3)", () => {
  /** Una compra paga con UNA sesión libre del pack A (presupuesta 30'). */
  async function lineaLibrePaga(sufijo: string) {
    const compra = await createCompra(db, {
      customerId: CUSTOMER_ID,
      depilationComboId: packAId,
      description: `${QA}_COMPRA_${sufijo}`,
      sessionsTotal: 1,
      baseAmount: 90000,
      discountedAmount: 90000,
      finalAmount: 90000,
    });
    const ahora = new Date();
    await db.insert(payments).values({
      customerId: CUSTOMER_ID,
      customerPurchaseId: compra.id,
      amount: "90000",
      paymentMethod: "cash",
      status: "confirmed",
      paymentDate: ahora,
      isDeclared: true,
      confirmedAt: ahora,
    });
    const libres = await lineasDeDepilacionLibres(db, CUSTOMER_ID, new Date());
    return libres.find((l) => l.purchaseId === compra.id)!.purchaseServiceId;
  }

  /**
   * La clienta del seed tiene el sexo en NULL, así que sin `sexo` el servidor
   * la trata como mujer: pierna(9) + axila(3) = 12'. Con el selector en
   * Hombre son pierna(10) + axila(5) = 15'. Los tres números que tienen que
   * coincidir son el bloque de agenda, el fin del turno y los minutos
   * congelados de cada zona.
   */
  it("un turno agendado en Hombre dura los minutos de hombre, y los congela así", async () => {
    const lineaId = await lineaLibrePaga("SEXO_HOMBRE");
    const turno = await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: anclaId,
      providerId: proveedoraId,
      start: "2026-10-19T13:00:00.000Z",
      customerPurchaseServiceId: lineaId,
      zonas: [piernaId, axilaId],
      sexo: "hombre",
      notes: QA,
    });

    expect(turno.durationMinutes).toBe(15);
    expect(turno.appointmentEnd).toEqual(new Date("2026-10-19T13:15:00.000Z"));

    const zonas = await zonasDelTurno(turno.id);
    expect(zonas.find((z) => z.bodyZoneId === piernaId)!.minutos).toBe(10);
    expect(zonas.find((z) => z.bodyZoneId === axilaId)!.minutos).toBe(5);
  });

  it("sin mandar sexo sigue saliendo el de la ficha (NULL ⇒ mujer): 12'", async () => {
    const lineaId = await lineaLibrePaga("SEXO_AUTO");
    const turno = await createAppointment(db, {
      customerId: CUSTOMER_ID,
      serviceId: anclaId,
      providerId: proveedoraId,
      start: "2026-10-19T15:00:00.000Z",
      customerPurchaseServiceId: lineaId,
      zonas: [piernaId, axilaId],
      notes: QA,
    });
    expect(turno.durationMinutes).toBe(12);
  });
});
