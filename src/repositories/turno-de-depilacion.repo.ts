import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { bodyZone, customerPurchase, customerPurchaseService, depilationComboZone } from "../db/schema";
import type { Categoria, Sexo } from "../lib/depilation-pricing";
import { notFound } from "../lib/errors";
import { armarMenu, type ZonaDelMenu, type ZonaDelPack } from "../lib/menu-de-zonas";
import { sexoDeLaClienta } from "./clientes-sexo.repo";
import { lineasDeDepilacionLibres } from "./consumo.repo";
import { leerConfig, obtenerCombo } from "./depilacion.repo";

/** Lo que la pantalla de turno nuevo necesita para ofrecer el menú de zonas
 *  y presupuestar la duración de la sesión de depilación. */
export type DatosParaAgendar = {
  nombreDelPack: string;
  sesion: number;
  sesionesTotales: number;
  presupuestoMinutos: number;
  sexo: Sexo;
  zonas: ZonaDelMenu[];
};

/**
 * Quién compró este servicio, para poder buscar su línea entre las libres.
 * `null` si el id no existe o no tiene clienta asociada.
 */
async function customerIdDePurchaseService(
  db: Db,
  purchaseServiceId: string,
): Promise<string | null> {
  const [fila] = await db
    .select({ customerId: customerPurchase.customerId })
    .from(customerPurchaseService)
    .innerJoin(
      customerPurchase,
      eq(customerPurchase.id, customerPurchaseService.customerPurchaseId),
    )
    .where(eq(customerPurchaseService.id, purchaseServiceId))
    .limit(1);
  return fila?.customerId ?? null;
}

/**
 * Las zonas que trae ESTE pack (`depilation_combo_zone` → `body_zone`), con
 * su estado real de `is_active`.
 *
 * A propósito NO filtra por activa: una zona archivada después de vendido el
 * pack sigue siendo parte de lo que la clienta pagó (`armarMenu` la muestra
 * deshabilitada, con el motivo). Filtrar acá la haría desaparecer del menú
 * como si el pack trajera menos de lo que trae.
 */
async function zonasDelPack(db: Db, comboId: string): Promise<ZonaDelPack[]> {
  const filas = await db
    .select({
      id: bodyZone.id,
      nombre: bodyZone.name,
      categoria: bodyZone.category,
      activa: bodyZone.isActive,
    })
    .from(depilationComboZone)
    .innerJoin(bodyZone, eq(bodyZone.id, depilationComboZone.zoneId))
    .where(eq(depilationComboZone.comboId, comboId));
  return filas.map((f) => ({ ...f, categoria: f.categoria as Categoria }));
}

/** Las zonas activas del catálogo: de ahí sale lo que se puede ofrecer de
 *  regalo en el lugar "a elección" (nunca una archivada). */
async function zonasActivasDelCatalogo(db: Db): Promise<ZonaDelPack[]> {
  const filas = await db
    .select({
      id: bodyZone.id,
      nombre: bodyZone.name,
      categoria: bodyZone.category,
      activa: bodyZone.isActive,
    })
    .from(bodyZone)
    .where(eq(bodyZone.isActive, true));
  return filas.map((f) => ({ ...f, categoria: f.categoria as Categoria }));
}

/**
 * Cuántas líneas de depilación de ESTE pack trae realmente esta compra.
 *
 * Existe porque `customer_purchase.sessions_total` —lo que trae
 * `LineaDeDepilacion.sesionesTotales`— es SIEMPRE 1 en un paquete de promo
 * (`ck` de la cabecera, ver `compras.repo.ts`), aunque ese paquete haya
 * traído varias líneas de este mismo pack adentro. Contar las filas reales
 * de `customer_purchase_service` es la única forma de que la pantalla diga
 * "sesión 1 de 3" y no "sesión 1 de 1" con 3 sesiones compradas.
 *
 * Cuenta TODAS las líneas (libres, reservadas o ya consumidas): es el total
 * que se vendió, no lo que queda por agendar — para eso ya está
 * `lineasDeDepilacionLibres`.
 */
async function sesionesTotalesDelPack(
  db: Db,
  purchaseId: string,
  depilationComboId: string,
): Promise<number> {
  const filas = await db
    .select({ id: customerPurchaseService.id })
    .from(customerPurchaseService)
    .where(
      and(
        eq(customerPurchaseService.customerPurchaseId, purchaseId),
        eq(customerPurchaseService.depilationComboId, depilationComboId),
      ),
    );
  return filas.length;
}

/**
 * Todo lo que la pantalla de turno nuevo necesita para agendar una sesión de
 * depilación: el menú de zonas para elegir y el presupuesto de minutos.
 *
 * El presupuesto sale de `obtenerCombo` (que arma el combo con
 * `assembleDepilationCombo`, Task 4) y no de una cuenta propia: es la MISMA
 * fórmula que ya usa el catálogo para calcular `duracionMinutos` — incluye
 * las zonas "a elección" como fantasmas chicas. Recalcular acá por cuenta
 * propia podría divergir del número que el catálogo ya mostró al vender el
 * pack.
 *
 * `sexoPedido` permite a la pantalla simular "¿y si fuera hombre?" sin volver
 * a cargar la clienta; sin eso, se lee `sexoDeLaClienta`.
 */
export async function datosParaAgendar(
  db: Db,
  purchaseServiceId: string,
  sexoPedido?: Sexo,
): Promise<DatosParaAgendar> {
  const customerId = await customerIdDePurchaseService(db, purchaseServiceId);
  if (!customerId) throw notFound("Servicio de depilación");

  const ahora = new Date();
  const libres = await lineasDeDepilacionLibres(db, customerId, ahora);
  const linea = libres.find((l) => l.purchaseServiceId === purchaseServiceId);
  if (!linea) throw notFound("Servicio de depilación");

  const sexo = sexoPedido ?? (await sexoDeLaClienta(db, customerId));

  const [combo, config, pack, catalogo, sesionesTotales] = await Promise.all([
    obtenerCombo(db, linea.depilationComboId, sexo),
    leerConfig(db),
    zonasDelPack(db, linea.depilationComboId),
    zonasActivasDelCatalogo(db),
    sesionesTotalesDelPack(db, linea.purchaseId, linea.depilationComboId),
  ]);
  if (!combo) throw notFound("Pack de depilación");

  const zonas = armarMenu(pack, catalogo, combo.choiceZoneCount, sexo, config);

  return {
    nombreDelPack: linea.nombreDelPack,
    sesion: linea.repeticion,
    sesionesTotales,
    presupuestoMinutos: combo.duracionMinutos,
    sexo,
    zonas,
  };
}
