import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointments,
  customerPurchase,
  customerPurchaseService,
  serviceProviders,
  serviceProviderService,
} from "../db/schema";
import type { Db } from "../db/client";
import { createPromotion, deletePromotionPermanently } from "../repositories/promotions.repo";
import { getAppointmentById, insertAppointment } from "../repositories/appointments.repo";
import { computeProviderEarning } from "./appointments.service";

/**
 * Integración de `computeProviderEarning` contra base real (1.53.0).
 *
 * La función pura (`gananciaDelTurno`, en pago-de-promo.test.ts) ya cubre la
 * lógica de "quién gana". Lo que NO cubre nadie es el `sql` crudo nuevo del
 * JOIN turno → customer_purchase_service → customer_purchase →
 * promotion_service: es plata real y es SQL crudo nuevo, la misma clase de
 * cambio que causó el 500 silencioso de V3a. Se demuestra acá, contra
 * `npm run db:reset:vacio`, sin depender de producción.
 */

// Igual que promotions.repo.test.ts y compañía: `createDbFromUrl` no existe
// con ese nombre, así que la conexión de prueba se arma a mano.
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const CUSTOMER_ID_DE_PRUEBA = "dddddddd-0000-0000-0000-000000000001"; // clienta del seed, no la toca traer-catalogo.sh
const NOMBRE_PROMO = "ZZ_QA_PAGO_DE_PROMO_promo";
const NOMBRE_PROVEEDORA_CON_PAGO = "ZZ_QA_PAGO_DE_PROMO_con_pago";
const NOMBRE_PROVEEDORA_SIN_PAGO = "ZZ_QA_PAGO_DE_PROMO_sin_pago";
const NOMBRE_PROVEEDORA_PAGO_CERO = "ZZ_QA_PAGO_DE_PROMO_pago_cero";
const NOMBRES_PROVEEDORAS_QA = [
  NOMBRE_PROVEEDORA_CON_PAGO,
  NOMBRE_PROVEEDORA_SIN_PAGO,
  NOMBRE_PROVEEDORA_PAGO_CERO,
];

let servicioId: string;
let proveedoraConPagoId: string;
let proveedoraSinPagoId: string;
let proveedoraPagoCeroId: string;
let promotionId: string;
let compraId: string;
let apptConPago: NonNullable<Awaited<ReturnType<typeof getAppointmentById>>>;
let apptSinPago: NonNullable<Awaited<ReturnType<typeof getAppointmentById>>>;
let apptPagoCero: NonNullable<Awaited<ReturnType<typeof getAppointmentById>>>;

/** Deja la base como si esta suite nunca hubiera corrido: turnos, compra,
 *  promo, acuerdos y proveedoras QA, por si una corrida anterior se cortó a
 *  mitad. Respeta las FK: compra (cascada a customer_purchase_service) →
 *  turnos → promo → acuerdos → proveedoras. */
async function limpiar() {
  const proveedoras = await db
    .select({ id: serviceProviders.id })
    .from(serviceProviders)
    .where(inArray(serviceProviders.fullName, NOMBRES_PROVEEDORAS_QA));
  const proveedoraIds = proveedoras.map((p) => p.id);

  const promo = await db
    .select({ id: schema.promotions.id })
    .from(schema.promotions)
    .where(eq(schema.promotions.name, NOMBRE_PROMO));

  if (promo.length > 0) {
    const compras = await db
      .select({ id: customerPurchase.id })
      .from(customerPurchase)
      .where(eq(customerPurchase.promotionId, promo[0]!.id));
    const compraIds = compras.map((c) => c.id);
    if (compraIds.length > 0) {
      // ON DELETE CASCADE se lleva puesto customer_purchase_service.
      await db.delete(customerPurchase).where(inArray(customerPurchase.id, compraIds));
    }
  }

  if (proveedoraIds.length > 0) {
    // Los turnos no tienen cascada desde customer_purchase_service — para
    // cuando llegamos acá la compra ya se borró arriba (o nunca existió), así
    // que esto sólo limpia turnos huérfanos de una corrida anterior.
    await db.delete(appointments).where(inArray(appointments.serviceProviderId, proveedoraIds));
  }

  if (promo.length > 0) await deletePromotionPermanently(db, promo[0]!.id);

  if (proveedoraIds.length > 0) {
    await db
      .delete(serviceProviderService)
      .where(inArray(serviceProviderService.serviceProviderId, proveedoraIds));
    await db.delete(serviceProviders).where(inArray(serviceProviders.id, proveedoraIds));
  }
}

beforeAll(async () => {
  await limpiar();

  const [s] = await db.execute<{ id: string }>(
    "select id from service where is_active = true limit 1" as never,
  );
  servicioId = s!.id;

  const [conPago] = await db
    .insert(serviceProviders)
    .values({ fullName: NOMBRE_PROVEEDORA_CON_PAGO, status: "active" })
    .returning({ id: serviceProviders.id });
  const [sinPago] = await db
    .insert(serviceProviders)
    .values({ fullName: NOMBRE_PROVEEDORA_SIN_PAGO, status: "active" })
    .returning({ id: serviceProviders.id });
  const [pagoCero] = await db
    .insert(serviceProviders)
    .values({ fullName: NOMBRE_PROVEEDORA_PAGO_CERO, status: "active" })
    .returning({ id: serviceProviders.id });
  proveedoraConPagoId = conPago!.id;
  proveedoraSinPagoId = sinPago!.id;
  proveedoraPagoCeroId = pagoCero!.id;

  // Acuerdo general para las tres: si el pago de la promo no gana, esto es lo
  // que se vería reflejado en el snapshot (y NO debería pasar para
  // proveedoraConPagoId ni proveedoraPagoCeroId).
  await db.insert(serviceProviderService).values([
    {
      serviceProviderId: proveedoraConPagoId,
      serviceId: servicioId,
      paymentType: "fixed_per_service",
      rate: "3000",
      isActive: true,
    },
    {
      serviceProviderId: proveedoraSinPagoId,
      serviceId: servicioId,
      paymentType: "fixed_per_service",
      rate: "5000",
      isActive: true,
    },
    {
      serviceProviderId: proveedoraPagoCeroId,
      serviceId: servicioId,
      paymentType: "fixed_per_service",
      rate: "9999",
      isActive: true,
    },
  ]);

  // La promo: pago acordado de 12000 para proveedoraConPagoId, pago acordado
  // de CERO para proveedoraPagoCeroId. proveedoraSinPagoId no tiene fila acá
  // — a propósito, es la que tiene que caer al acuerdo general.
  const promo = await createPromotion(
    db,
    { name: NOMBRE_PROMO, promotionType: "fixed_amount" },
    [{ tipo: "servicio", id: servicioId }],
    [
      { serviceId: servicioId, serviceProviderId: proveedoraConPagoId, providerPayment: 12000 },
      { serviceId: servicioId, serviceProviderId: proveedoraPagoCeroId, providerPayment: 0 },
    ],
  );
  promotionId = promo!.id;

  // Una compra hecha con esa promo (servicio suelto, no combo — no hace falta
  // para lo que se está probando).
  const [compra] = await db
    .insert(customerPurchase)
    .values({
      customerId: CUSTOMER_ID_DE_PRUEBA,
      serviceId: servicioId,
      description: "ZZ_QA_PAGO_DE_PROMO — compra de prueba",
      sessionsTotal: 3,
      baseAmount: "3000",
      discountedAmount: "3000",
      finalAmount: "3000",
      promotionId,
      promotionName: promo!.name,
    })
    .returning({ id: customerPurchase.id });
  compraId = compra!.id;

  // Tres turnos, uno por proveedora, cada uno con su propia sesión de la
  // misma compra — así el JOIN entra por `appointment_id` como en producción.
  // `repeticion` distinta por sesión: son 3 filas de la misma compra/servicio
  // y `ux_cpsv_fila` exige (compra, repetición, servicio, orden) único.
  const crearTurno = async (serviceProviderId: string, repeticion: number) => {
    const inserted = await insertAppointment(db, {
      customerId: CUSTOMER_ID_DE_PRUEBA,
      serviceProviderId,
      serviceId: servicioId,
      durationMinutes: 60,
      status: "scheduled",
    });
    await db.insert(customerPurchaseService).values({
      customerPurchaseId: compraId,
      serviceId: servicioId,
      repeticion,
      appointmentId: inserted.id,
    });
    return (await getAppointmentById(db, inserted.id))!;
  };

  apptConPago = await crearTurno(proveedoraConPagoId, 1);
  apptSinPago = await crearTurno(proveedoraSinPagoId, 2);
  apptPagoCero = await crearTurno(proveedoraPagoCeroId, 3);
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("computeProviderEarning — pago de promo contra base real", () => {
  it("con pago acordado: el turno sale de la compra con promo y esa promo le fija un pago a esta proveedora — ese monto gana, no el acuerdo general (3000)", async () => {
    const resultado = await computeProviderEarning(db, apptConPago);
    expect(resultado).toEqual({
      providerPaymentType: "promo",
      providerRate: null,
      providerEarning: "12000.00",
    });
  });

  it("con otra proveedora: el turno lo atendió una proveedora sin pago acordado en esta promo — rige el acuerdo general (5000)", async () => {
    const resultado = await computeProviderEarning(db, apptSinPago);
    expect(resultado).toEqual({
      providerPaymentType: "fixed_per_service",
      providerRate: "5000.00",
      providerEarning: "5000.00",
    });
  });

  it("pago acordado de cero: la dueña acordó no pagarle nada por este servicio en promo — devuelve cero, NO el acuerdo general (9999)", async () => {
    const resultado = await computeProviderEarning(db, apptPagoCero);
    expect(resultado).toEqual({
      providerPaymentType: "promo",
      providerRate: null,
      providerEarning: "0.00",
    });
  });
});
