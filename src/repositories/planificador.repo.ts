import { and, asc, eq, gte, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  appointments,
  comboService,
  combos,
  contacts,
  customerPurchase,
  customerPurchaseService,
  customers,
  depilationCombo,
  promotions,
  promotionTarget,
  service,
} from "../db/schema";
import { minutosElegidos } from "../lib/menu-de-zonas";
import { puertaDePago } from "../lib/puerta-de-pago";
import { comboDelQueSalenLosServicios } from "../lib/servicios-comprados";
import { utcToLocalDateString } from "../lib/time";
import { getPagadoDeCompra } from "./compras.repo";
import { leerDiasEntreSesiones } from "./depilacion.repo";
import { datosParaAgendar } from "./turno-de-depilacion.repo";

// Los días sugeridos entre sesiones de una compra (spec 2026-10-22-planificador-de-la-compra).

/** Lo que se sugiere cuando nadie cargó los días. */
const DIAS_POR_DEFECTO = 30;

export type IntervaloDeLaCompra = { dias: number; cargado: boolean };

/** Los días propios de un combo o pack; si es un pack sin días, los de su combo. */
async function diasDeUnCombo(db: Db, comboId: string): Promise<number | null> {
  const [c] = await db
    .select({ dias: combos.sessionIntervalDays, kind: combos.kind, packOf: combos.packOfComboId })
    .from(combos)
    .where(eq(combos.id, comboId))
    .limit(1);
  if (!c) return null;
  if (c.dias != null) return c.dias;
  const origen = comboDelQueSalenLosServicios(c.kind, c.packOf, comboId);
  if (origen === comboId) return null;
  const [o] = await db
    .select({ dias: combos.sessionIntervalDays })
    .from(combos)
    .where(eq(combos.id, origen))
    .limit(1);
  return o?.dias ?? null;
}

/**
 * Los días propios de una promo; si no tiene, los del primer combo o pack de
 * adentro que los tenga. "Primero" = por `created_at` de `promotion_target` y,
 * a igual fecha, por `id`: así el resultado no depende del orden en que
 * Postgres devuelva las filas.
 */
async function diasDeUnaPromo(db: Db, promocionId: string): Promise<number | null> {
  const [p] = await db
    .select({ dias: promotions.sessionIntervalDays })
    .from(promotions)
    .where(eq(promotions.id, promocionId))
    .limit(1);
  if (p?.dias != null) return p.dias;
  const destinos = await db
    .select({ comboId: promotionTarget.comboId })
    .from(promotionTarget)
    .where(and(eq(promotionTarget.promotionId, promocionId), isNotNull(promotionTarget.comboId)))
    .orderBy(asc(promotionTarget.createdAt), asc(promotionTarget.id));
  for (const d of destinos) {
    const dias = await diasDeUnCombo(db, d.comboId!);
    if (dias != null) return dias;
  }
  return null;
}

/**
 * Cada cuántos días se sugiere la siguiente sesión de una compra. Orden: lo
 * propio de lo que se compró → (pack de combo) el de su combo → (promo) el del
 * primer combo o pack de adentro que lo tenga → (depilación) el de
 * `depilation_pricing_config` → 30 con `cargado: false`, para que la pantalla
 * avise que es un número supuesto.
 */
export async function intervaloDeLaCompra(db: Db, compraId: string): Promise<IntervaloDeLaCompra> {
  const [c] = await db
    .select({
      comboId: customerPurchase.comboId,
      depilacionId: customerPurchase.depilationComboId,
      promocionId: customerPurchase.promotionId,
    })
    .from(customerPurchase)
    .where(eq(customerPurchase.id, compraId))
    .limit(1);

  let dias: number | null = null;
  if (c?.comboId) dias = await diasDeUnCombo(db, c.comboId);
  if (dias == null && c?.promocionId) dias = await diasDeUnaPromo(db, c.promocionId);
  if (dias == null && c?.depilacionId) {
    const [d] = await db
      .select({ dias: depilationCombo.sessionIntervalDays })
      .from(depilationCombo)
      .where(eq(depilationCombo.id, c.depilacionId))
      .limit(1);
    dias = d?.dias ?? (await leerDiasEntreSesiones(db));
  }
  return dias != null ? { dias, cargado: true } : { dias: DIAS_POR_DEFECTO, cargado: false };
}

// ── La base del plan ────────────────────────────────────────────────────────

export type SesionPlanificable = {
  purchaseServiceId: string;
  vuelta: number; // customer_purchase_service.repeticion
  orden: number; // dentro de la vuelta, el orden del combo/promo (1..n)
  nombre: string;
  serviceId: string; // en depilación, el servicio ancla
  esDepilacion: boolean;
  zonas: string[]; // depilación: TODAS las del pack (sin las "a elección"); si no, []
  duracionMinutos: number; // servicio: su duración; depilación: minutosElegidos(zonas) para el sexo de la clienta
  juntos: boolean; // el combo de la línea está marcado "se hacen juntos"
};

export type BaseDelPlanificador = {
  compraId: string;
  customerId: string;
  clienta: string; // nombre para los textos
  descripcion: string;
  intervalo: IntervaloDeLaCompra;
  venceEl: string | null; // YYYY-MM-DD, de la vigencia de la compra
  puerta: { total: number; pagado: number; minimo: number } | null; // sólo depilación
  turnosDeLaClienta: { start: string; end: string }[]; // futuros, no cancelados
  sesiones: SesionPlanificable[]; // libres, ordenadas por vuelta y orden
};

/** El combo del que salen los servicios de la compra (el pack repite el de otro combo). */
async function comboDeOrigen(db: Db, comboId: string | null): Promise<string | null> {
  if (!comboId) return null;
  const [c] = await db
    .select({ kind: combos.kind, packOf: combos.packOfComboId })
    .from(combos)
    .where(eq(combos.id, comboId))
    .limit(1);
  return c ? comboDelQueSalenLosServicios(c.kind, c.packOf, comboId) : null;
}

/** ¿Ese combo se hace "todo junto"? */
async function sonJuntos(db: Db, origenId: string | null): Promise<boolean> {
  if (!origenId) return false;
  const [real] = await db
    .select({ juntos: combos.servicesTogether })
    .from(combos)
    .where(eq(combos.id, origenId))
    .limit(1);
  return real?.juntos === true;
}

/**
 * Lo que el planificador necesita para armar las cards de una compra: sus
 * sesiones libres en orden, con duración y zonas, los números de la puerta de
 * pago y lo que la clienta ya tiene agendado. `null` si la compra no existe.
 *
 * "Libre" es la misma definición que `condicionDeServicioLibre` (sin consumir y
 * sin turno vivo; un turno cancelado no la reserva), acotada a esta compra. Las
 * capacitaciones (sin servicio ni pack de depilación) no son un turno de agenda
 * y no tienen card.
 *
 * Orden: primero por vuelta (`repeticion`); dentro de la vuelta, por la columna
 * `orden` de la línea (en un paquete de promo es la posición en la promo) y, a
 * igual `orden`, por la posición del servicio en `combo_service.created_at`
 * (el combo no guarda otro orden). La posición se numera entre TODAS las líneas
 * de la vuelta, no sólo entre las libres: que una ya esté agendada no corre a
 * las demás.
 */
export async function basePlanificador(db: Db, compraId: string): Promise<BaseDelPlanificador | null> {
  const [compra] = await db
    .select({
      id: customerPurchase.id,
      customerId: customerPurchase.customerId,
      descripcion: customerPurchase.description,
      comboId: customerPurchase.comboId,
      finalAmount: customerPurchase.finalAmount,
      expiresAt: customerPurchase.expiresAt,
      cancelledAt: customerPurchase.cancelledAt,
      clienta: contacts.name,
    })
    .from(customerPurchase)
    .leftJoin(customers, eq(customers.id, customerPurchase.customerId))
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .where(eq(customerPurchase.id, compraId))
    .limit(1);
  if (!compra || !compra.customerId) return null;

  const ahora = new Date();
  const origenId = await comboDeOrigen(db, compra.comboId);
  const compraViva = compra.cancelledAt == null && (compra.expiresAt == null || compra.expiresAt >= ahora);

  // Todas las líneas con turno de agenda (servicio o pack de depilación),
  // libres o no, para numerar la posición dentro de la vuelta.
  const lineas = await db
    .select({
      id: customerPurchaseService.id,
      repeticion: customerPurchaseService.repeticion,
      orden: customerPurchaseService.orden,
      serviceId: customerPurchaseService.serviceId,
      depilationComboId: customerPurchaseService.depilationComboId,
      consumedAt: customerPurchaseService.consumedAt,
      appointmentId: customerPurchaseService.appointmentId,
      turnoStatus: appointments.status,
      serviceName: service.name,
      serviceMinutos: service.estimatedDurationMinutes,
      packName: depilationCombo.name,
      posicion: comboService.createdAt,
    })
    .from(customerPurchaseService)
    .innerJoin(customerPurchase, eq(customerPurchase.id, customerPurchaseService.customerPurchaseId))
    .leftJoin(appointments, eq(appointments.id, customerPurchaseService.appointmentId))
    .leftJoin(service, eq(service.id, customerPurchaseService.serviceId))
    .leftJoin(depilationCombo, eq(depilationCombo.id, customerPurchaseService.depilationComboId))
    .leftJoin(
      comboService,
      and(
        eq(comboService.serviceId, customerPurchaseService.serviceId),
        // El combo del que salen los servicios (el de un pack, el que repite).
        eq(comboService.comboId, origenId ?? "00000000-0000-0000-0000-000000000000"),
      ),
    )
    .where(
      and(
        eq(customerPurchaseService.customerPurchaseId, compraId),
        or(isNotNull(customerPurchaseService.serviceId), isNotNull(customerPurchaseService.depilationComboId)),
      ),
    );

  // combo_service no tiene columna de posición: si `created_at` empata (un solo
  // INSERT multi-fila), el desempate cae al nombre del servicio y luego al id.
  const ordenadas = lineas.sort(
    (a, b) =>
      (a.repeticion ?? 0) - (b.repeticion ?? 0) ||
      (a.orden ?? 0) - (b.orden ?? 0) ||
      (a.posicion?.getTime() ?? 0) - (b.posicion?.getTime() ?? 0) ||
      (a.serviceName ?? a.packName ?? "").localeCompare(b.serviceName ?? b.packName ?? "", "es") ||
      a.id.localeCompare(b.id),
  );

  // Posición dentro de la vuelta, contando las libres y las que no.
  const posiciones = new Map<string, number>();
  const contador = new Map<number, number>();
  for (const l of ordenadas) {
    const v = l.repeticion ?? 1;
    const n = (contador.get(v) ?? 0) + 1;
    contador.set(v, n);
    posiciones.set(l.id, n);
  }

  const libres = ordenadas.filter(
    (l) =>
      compraViva &&
      l.consumedAt == null &&
      (l.appointmentId == null || l.turnoStatus === "cancelled"),
  );

  const juntos = await sonJuntos(db, origenId);

  // Depilación: el menú de zonas (y el sexo de la clienta) lo resuelve
  // `datosParaAgendar`, una vez por pack distinto.
  const datosPorPack = new Map<string, Awaited<ReturnType<typeof datosParaAgendar>>>();
  for (const l of libres) {
    if (l.depilationComboId && !datosPorPack.has(l.depilationComboId)) {
      datosPorPack.set(l.depilationComboId, await datosParaAgendar(db, l.id));
    }
  }

  const sesiones: SesionPlanificable[] = libres.map((l) => {
    const base = {
      purchaseServiceId: l.id,
      vuelta: l.repeticion ?? 1,
      orden: posiciones.get(l.id)!,
    };
    if (l.depilationComboId) {
      const datos = datosPorPack.get(l.depilationComboId)!;
      const delPack = datos.zonas.filter((z) => !z.esDeRegalo);
      return {
        ...base,
        nombre: l.packName ?? datos.nombreDelPack,
        serviceId: datos.serviceId,
        esDepilacion: true,
        zonas: delPack.map((z) => z.id),
        duracionMinutos: minutosElegidos(datos.zonas, delPack.map((z) => z.id)),
        juntos: false,
      };
    }
    return {
      ...base,
      nombre: l.serviceName ?? "",
      serviceId: l.serviceId!,
      esDepilacion: false,
      zonas: [],
      duracionMinutos: l.serviceMinutos ?? 0,
      juntos,
    };
  });

  let puerta: BaseDelPlanificador["puerta"] = null;
  if (sesiones.some((s) => s.esDepilacion)) {
    const total = Number(compra.finalAmount ?? 0);
    const pagado = await getPagadoDeCompra(db, compraId);
    // Lo que pide la puerta con varias sesiones libres: el 40% redondeado.
    const { faltaCobrar: minimo } = puertaDePago({
      finalAmount: total,
      pagado: 0,
      esPaquete: true,
      sesionesTotales: 2,
      sesionesLibres: 2,
    });
    puerta = { total, pagado, minimo };
  }

  const futuros = await db
    .select({ start: appointments.appointmentStart, end: appointments.appointmentEnd })
    .from(appointments)
    .where(
      and(
        eq(appointments.customerId, compra.customerId),
        gte(appointments.appointmentStart, ahora),
        or(isNull(appointments.status), ne(appointments.status, "cancelled")),
      ),
    )
    .orderBy(asc(appointments.appointmentStart));

  return {
    compraId: compra.id,
    customerId: compra.customerId,
    clienta: compra.clienta ?? "",
    descripcion: compra.descripcion ?? "",
    intervalo: await intervaloDeLaCompra(db, compraId),
    venceEl: compra.expiresAt ? utcToLocalDateString(compra.expiresAt) : null,
    puerta,
    turnosDeLaClienta: futuros
      .filter((t) => t.start && t.end)
      .map((t) => ({ start: t.start!.toISOString(), end: t.end!.toISOString() })),
    sesiones,
  };
}
