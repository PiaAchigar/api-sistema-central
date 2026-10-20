import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  appointments,
  contacts,
  customerPurchase,
  customers,
  serviceProviders,
  training,
  trainingSessions,
} from "../db/schema";
import { conflict, notFound } from "../lib/errors";
import { getDeudasDeCompras } from "./compras.repo";

// Encuentros de una capacitación (training_sessions). Las horas son LOCALES
// del negocio (ART), "HH:MM:SS", igual que activity_schedules.

export type Encuentro = {
  id: string;
  trainingId: string;
  sessionNumber: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  serviceProviderId: string | null;
  providerName: string | null;
  location: string | null;
  capacity: number | null;
  isActive: boolean;
  /** Turnos con este encuentro cuyo status no es cancelled. */
  anotadas: number;
};

export type EncuentroInput = {
  sessionNumber: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  serviceProviderId?: string | null;
  location?: string | null;
  capacity?: number | null;
};

const columnas = {
  id: trainingSessions.id,
  trainingId: trainingSessions.trainingId,
  sessionNumber: trainingSessions.sessionNumber,
  sessionDate: trainingSessions.sessionDate,
  startTime: trainingSessions.startTime,
  endTime: trainingSessions.endTime,
  serviceProviderId: trainingSessions.serviceProviderId,
  providerName: serviceProviders.fullName,
  location: trainingSessions.location,
  capacity: trainingSessions.capacity,
  isActive: trainingSessions.isActive,
};

type Fila = {
  [K in keyof typeof columnas]: unknown;
};

function aEncuentro(f: Fila, anotadas: number): Encuentro {
  return {
    id: f.id as string,
    trainingId: f.trainingId as string,
    sessionNumber: (f.sessionNumber as number | null) ?? 1,
    sessionDate: f.sessionDate as string,
    startTime: f.startTime as string,
    endTime: f.endTime as string,
    serviceProviderId: (f.serviceProviderId as string | null) ?? null,
    providerName: (f.providerName as string | null) ?? null,
    location: (f.location as string | null) ?? null,
    capacity: (f.capacity as number | null) ?? null,
    isActive: (f.isActive as boolean | null) ?? true,
    anotadas,
  };
}

async function contarAnotadas(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const filas = await db
    .select({ id: appointments.trainingSessionId, n: sql<number>`count(*)::int` })
    .from(appointments)
    .where(and(inArray(appointments.trainingSessionId, ids), ne(appointments.status, "cancelled")))
    .groupBy(appointments.trainingSessionId);
  return new Map(filas.map((f) => [f.id as string, f.n]));
}

/** Violación del índice único (training_id, session_number): 23505 de Postgres. */
function esNumeroRepetido(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

const mensajeNumeroRepetido = (n: number | undefined) =>
  `Ya hay un encuentro N.º ${n} en esta capacitación`;

export async function listEncuentros(
  db: Db,
  trainingId: string,
  opts: { incluirInactivos?: boolean },
): Promise<Encuentro[]> {
  const condiciones = [eq(trainingSessions.trainingId, trainingId)];
  if (!opts.incluirInactivos) condiciones.push(eq(trainingSessions.isActive, true));
  const filas = await db
    .select(columnas)
    .from(trainingSessions)
    .leftJoin(serviceProviders, eq(serviceProviders.id, trainingSessions.serviceProviderId))
    .where(and(...condiciones))
    .orderBy(asc(trainingSessions.sessionNumber));
  const anotadas = await contarAnotadas(db, filas.map((f) => f.id));
  return filas.map((f) => aEncuentro(f, anotadas.get(f.id) ?? 0));
}

async function getEncuentro(db: Db, id: string): Promise<Encuentro> {
  const [fila] = await db
    .select(columnas)
    .from(trainingSessions)
    .leftJoin(serviceProviders, eq(serviceProviders.id, trainingSessions.serviceProviderId))
    .where(eq(trainingSessions.id, id));
  if (!fila) throw notFound("Encuentro");
  const anotadas = await contarAnotadas(db, [id]);
  return aEncuentro(fila, anotadas.get(id) ?? 0);
}

export async function crearEncuentro(db: Db, trainingId: string, input: EncuentroInput): Promise<Encuentro> {
  const [cap] = await db.select({ id: training.id }).from(training).where(eq(training.id, trainingId));
  if (!cap) throw notFound("Training");
  let creado: { id: string } | undefined;
  try {
    [creado] = await db
    .insert(trainingSessions)
    .values({
      trainingId,
      sessionNumber: input.sessionNumber,
      sessionDate: input.sessionDate,
      startTime: input.startTime,
      endTime: input.endTime,
      serviceProviderId: input.serviceProviderId ?? null,
      location: input.location ?? null,
      capacity: input.capacity ?? null,
    })
    .returning({ id: trainingSessions.id });
  } catch (err) {
    // El índice único cuenta también los encuentros inactivos.
    if (esNumeroRepetido(err)) throw conflict(mensajeNumeroRepetido(input.sessionNumber));
    throw err;
  }
  return getEncuentro(db, creado!.id);
}

export async function editarEncuentro(
  db: Db,
  id: string,
  input: Partial<EncuentroInput> & { isActive?: boolean },
): Promise<Encuentro> {
  const cambios: Partial<typeof trainingSessions.$inferInsert> = {};
  if (input.sessionNumber !== undefined) cambios.sessionNumber = input.sessionNumber;
  if (input.sessionDate !== undefined) cambios.sessionDate = input.sessionDate;
  if (input.startTime !== undefined) cambios.startTime = input.startTime;
  if (input.endTime !== undefined) cambios.endTime = input.endTime;
  if (input.serviceProviderId !== undefined) cambios.serviceProviderId = input.serviceProviderId;
  if (input.location !== undefined) cambios.location = input.location;
  if (input.capacity !== undefined) cambios.capacity = input.capacity;
  if (input.isActive !== undefined) cambios.isActive = input.isActive;

  if (Object.keys(cambios).length > 0) {
    let r: { id: string }[];
    try {
      r = await db
        .update(trainingSessions)
        .set({ ...cambios, updatedAt: new Date() })
        .where(eq(trainingSessions.id, id))
        .returning({ id: trainingSessions.id });
    } catch (err) {
      if (esNumeroRepetido(err)) throw conflict(mensajeNumeroRepetido(input.sessionNumber));
      throw err;
    }
    if (r.length === 0) throw notFound("Encuentro");
  }
  return getEncuentro(db, id);
}

/** Suma `dias` a una fecha YYYY-MM-DD en UTC (sin corrimientos por huso). */
function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Arma de una vez los encuentros semanales de una capacitación: el primer
 * `diaDeLaSemana` (0=domingo) a partir de `desde`, y de a 7 días. Solo sobre
 * una capacitación sin encuentros activos: si ya hay, se editan de a uno.
 */
export async function generarEncuentros(
  db: Db,
  trainingId: string,
  input: {
    desde: string;
    diaDeLaSemana: number;
    startTime: string;
    endTime: string;
    serviceProviderId?: string | null;
    cantidad?: number;
  },
): Promise<Encuentro[]> {
  const [cap] = await db
    .select({ totalSessions: training.totalSessions })
    .from(training)
    .where(eq(training.id, trainingId));
  if (!cap) throw notFound("Training");

  // Cualquier encuentro cuenta, también los inactivos: el índice único
  // (training_id, session_number) los incluye y el 1..N chocaría.
  const existentes = await listEncuentros(db, trainingId, { incluirInactivos: true });
  if (existentes.length > 0) {
    throw conflict("Esta capacitación ya tiene encuentros: editalos uno por uno");
  }

  const cantidad = input.cantidad ?? cap.totalSessions ?? 0;
  if (cantidad < 1) throw conflict("La capacitación no tiene cantidad de encuentros definida");

  const diaDesde = new Date(`${input.desde}T00:00:00Z`).getUTCDay();
  const primera = sumarDias(input.desde, (input.diaDeLaSemana - diaDesde + 7) % 7);

  const filas = Array.from({ length: cantidad }, (_, i) => ({
    trainingId,
    sessionNumber: i + 1,
    sessionDate: sumarDias(primera, 7 * i),
    startTime: input.startTime,
    endTime: input.endTime,
    serviceProviderId: input.serviceProviderId ?? null,
  }));
  await db.insert(trainingSessions).values(filas);
  return listEncuentros(db, trainingId, {});
}

export type Inscripta = {
  customerPurchaseId: string;
  customerId: string;
  nombre: string;
  /** ISO de purchased_at (cae en created_at si la compra no lo trae). */
  compradaEl: string;
  debe: number;
  /** Encuentros activos de la capacitación en que tiene un turno no cancelado. */
  encuentrosAnotada: number;
  encuentrosTotales: number;
};

/**
 * Quiénes compraron la capacitación: compras vivas (sin cancelar), por nombre.
 * Tres consultas fijas sin importar cuántas inscriptas haya: compras, deudas
 * (getDeudasDeCompras) y conteos de turnos por clienta.
 */
export async function listInscriptas(db: Db, trainingId: string): Promise<Inscripta[]> {
  const compras = await db
    .select({
      customerPurchaseId: customerPurchase.id,
      customerId: customerPurchase.customerId,
      nombre: contacts.name,
      purchasedAt: customerPurchase.purchasedAt,
      createdAt: customerPurchase.createdAt,
    })
    .from(customerPurchase)
    .leftJoin(customers, eq(customers.id, customerPurchase.customerId))
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .where(and(eq(customerPurchase.trainingId, trainingId), isNull(customerPurchase.cancelledAt)))
    .orderBy(asc(contacts.name), asc(customerPurchase.purchasedAt));
  if (compras.length === 0) return [];

  const deudas = await getDeudasDeCompras(db, compras.map((c) => c.customerPurchaseId));

  // Los encuentros desactivados no cuentan ni en el total ni en lo anotado.
  const [totales] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(trainingSessions)
    .where(and(eq(trainingSessions.trainingId, trainingId), eq(trainingSessions.isActive, true)));
  const encuentrosTotales = totales?.n ?? 0;

  const clientaIds = [...new Set(compras.map((c) => c.customerId).filter((x): x is string => !!x))];
  const anotadas = new Map<string, number>();
  if (clientaIds.length > 0) {
    const filas = await db
      .select({ customerId: appointments.customerId, n: sql<number>`count(distinct ${appointments.trainingSessionId})::int` })
      .from(appointments)
      .innerJoin(trainingSessions, eq(trainingSessions.id, appointments.trainingSessionId))
      .where(
        and(
          eq(trainingSessions.trainingId, trainingId),
          eq(trainingSessions.isActive, true),
          ne(appointments.status, "cancelled"),
          inArray(appointments.customerId, clientaIds),
        ),
      )
      .groupBy(appointments.customerId);
    for (const f of filas) anotadas.set(f.customerId as string, f.n);
  }

  return compras.map((c) => ({
    customerPurchaseId: c.customerPurchaseId,
    customerId: c.customerId as string,
    nombre: c.nombre ?? "",
    compradaEl: (c.purchasedAt ?? c.createdAt)?.toISOString() ?? "",
    debe: deudas.get(c.customerPurchaseId) ?? 0,
    encuentrosAnotada: anotadas.get(c.customerId as string) ?? 0,
    encuentrosTotales,
  }));
}
