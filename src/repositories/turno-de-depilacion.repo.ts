import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { bodyZone, customerPurchase, customerPurchaseService, depilationComboZone } from "../db/schema";
import type { Categoria, Sexo } from "../lib/depilation-pricing";
import { notFound } from "../lib/errors";
import { armarMenu, type ZonaDelMenu, type ZonaDelPack } from "../lib/menu-de-zonas";
import { puertaDePago, type EstadoDePuerta } from "../lib/puerta-de-pago";
import { anclaDeDepilacion } from "./ancla-de-depilacion.repo";
import { getPagadoDeCompra } from "./compras.repo";
import { sexoDeLaClienta } from "./clientes-sexo.repo";
import { lineasDeDepilacionLibres, type LineaDeDepilacion } from "./consumo.repo";
import { leerConfig, obtenerCombo } from "./depilacion.repo";

/** Lo que la pantalla de turno nuevo necesita para ofrecer el menú de zonas
 *  y presupuestar la duración de la sesión de depilación. */
export type DatosParaAgendar = {
  nombreDelPack: string;
  sesion: number;
  sesionesTotales: number;
  presupuestoMinutos: number;
  /**
   * El tope de zonas "a elección" del pack (`choiceZoneCount`): **hasta** N,
   * no "todas las chicas que entren en los minutos" (spec §7.2).
   *
   * Viaja a la pantalla para que el menú no ofrezca lo que el servidor va a
   * rechazar. La verdad sigue estando en el servidor: `createAppointment` lo
   * vuelve a validar con `regalosElegidos`.
   */
  zonasDeRegalo: number;
  sexo: Sexo;
  zonas: ZonaDelMenu[];
  /** Si esta sesión se puede AGENDAR o sólo RESERVAR (Task 13). */
  puerta: EstadoDePuerta;
  /**
   * El `service` ancla de depilación (Task 15, ronda de arreglos 1): el
   * `serviceId` que la pantalla tiene que mandar en `POST /appointments` y
   * el que necesita para pedir qué prestadoras ofrecen la sesión.
   *
   * El ancla NO vive en ningún catálogo que la pantalla pueda consultar por
   * su cuenta — `listServices` la excluye a propósito (`services.repo.ts`:
   * "no es un servicio que Laura cargue, edite o borre") porque no se
   * vende, es plomería interna para colgarle proveedoras y máquina. Este
   * endpoint es el único lugar donde la pantalla puede enterarse de qué
   * UUID es: si no viaja acá, no hay forma de armar el turno.
   */
  serviceId: string;
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

/** El `final_amount` de la compra, para la puerta de pago. */
async function finalAmountDeCompra(db: Db, purchaseId: string): Promise<number> {
  const [fila] = await db
    .select({ finalAmount: customerPurchase.finalAmount })
    .from(customerPurchase)
    .where(eq(customerPurchase.id, purchaseId))
    .limit(1);
  return Number(fila?.finalAmount ?? 0);
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
 * La puerta de pago (Task 13) de una línea de depilación puntual — la cuenta
 * que decide `puedeAgendar`, `motivo` y `faltaCobrar`.
 *
 * La comparten los DOS caminos que pueden convertir una reserva de
 * depilación en turno real:
 *
 * - `datosParaAgendar` (crear un turno nuevo): la línea todavía está LIBRE,
 *   así que ya se cuenta sola dentro de `libres`.
 * - `puertaDeLaReserva` (confirmar, completar o RESTAURAR un turno ya
 *   existente, rondas 1 y 3): si el turno sigue vivo, la línea ya lo tiene
 *   enganchado y `lineasDeDepilacionLibres` la EXCLUYE de `libres` —
 *   `lineaYaTomada: true` la suma de vuelta. Sigue siendo la misma sesión
 *   "en juego"; lo único que cambió es que ya tiene un turno atado.
 *   **Pero un turno CANCELADO libera su línea**
 *   (`condicionDeLineaDeDepilacionLibre` trata `cancelled` como libre), así
 *   que ahí ya viene contada dentro de `libres` y sumarla de nuevo la
 *   contaría dos veces: la última sesión del pack dejaría de parecer la
 *   última y pediría el 40% en vez del 100%. Por eso `lineaYaTomada` lo
 *   decide quien llama, mirando si la línea está o no en `libres`.
 *
 * Es la única función que arma el input de `puertaDePago`: si mañana cambia
 * qué cuenta como "la última sesión libre", cambia acá y los dos caminos lo
 * heredan — no hay una segunda cuenta para que se desincronice.
 */
async function puertaDeLaLinea(
  db: Db,
  opts: {
    purchaseId: string;
    esPaquete: boolean;
    sesionesTotales: number;
    libres: LineaDeDepilacion[];
    lineaYaTomada: boolean;
  },
): Promise<EstadoDePuerta> {
  const [finalAmount, pagado] = await Promise.all([
    finalAmountDeCompra(db, opts.purchaseId),
    // "Lo pagado" es la MISMA cuenta que usa la ficha de la compra
    // (`getPagadoDeCompra`, "la única definición del saldo"): la suma de los
    // `payments` CONFIRMADOS de esa compra. Inventar una consulta propia acá
    // podría mostrarle a Laura dos números distintos para lo mismo.
    getPagadoDeCompra(db, opts.purchaseId),
  ]);
  const sesionesLibres =
    opts.libres.filter((l) => l.purchaseId === opts.purchaseId).length +
    (opts.lineaYaTomada ? 1 : 0);

  return puertaDePago({
    finalAmount,
    pagado,
    esPaquete: opts.esPaquete,
    sesionesTotales: opts.sesionesTotales,
    sesionesLibres,
  });
}

/**
 * La puerta de pago para un turno RESERVADO que se quiere confirmar o
 * completar de un salto (Task 13, ronda 1 — "Confirmar reserva" y
 * "Realizado" en `updateAppointmentStatus`).
 *
 * A diferencia de `datosParaAgendar` —pensada para un turno por CREAR, con la
 * línea todavía libre—, ésta lee la línea que YA está tomada por
 * `appointmentId`: no puede pasar por `lineasDeDepilacionLibres` para
 * encontrarla (esa función la excluye a propósito, es lo que la hace
 * "libre"). Por eso el `select` busca directo por `appointmentId`.
 *
 * `null` cuando el turno no tiene ninguna línea de depilación enganchada —no
 * debería pasar en un turno del servicio ancla creado por `createAppointment`
 * (que siempre exige `customerPurchaseServiceId`), pero si pasa, no es esta
 * función la que decide qué hacer con eso.
 */
export async function puertaDeLaReserva(
  db: Db,
  appointmentId: string,
): Promise<EstadoDePuerta | null> {
  const [fila] = await db
    .select({
      purchaseServiceId: customerPurchaseService.id,
      customerId: customerPurchase.customerId,
      purchaseId: customerPurchase.id,
      depilationComboId: customerPurchaseService.depilationComboId,
      esPaquete: customerPurchase.esPaqueteDePromo,
    })
    .from(customerPurchaseService)
    .innerJoin(
      customerPurchase,
      eq(customerPurchase.id, customerPurchaseService.customerPurchaseId),
    )
    .where(eq(customerPurchaseService.appointmentId, appointmentId))
    .limit(1);
  if (!fila || !fila.customerId || !fila.depilationComboId) return null;

  const ahora = new Date();
  const [libres, sesionesTotales] = await Promise.all([
    lineasDeDepilacionLibres(db, fila.customerId, ahora),
    sesionesTotalesDelPack(db, fila.purchaseId, fila.depilationComboId),
  ]);

  return puertaDeLaLinea(db, {
    purchaseId: fila.purchaseId,
    esPaquete: fila.esPaquete,
    sesionesTotales,
    libres,
    // `true` sólo si esta línea NO está ya contada entre las libres. Con un
    // turno vivo (reservado) no está y hay que sumarla; con uno cancelado
    // —el camino de "Restaurar"— sí está, y sumarla la contaría dos veces.
    lineaYaTomada: !libres.some((l) => l.purchaseServiceId === fila.purchaseServiceId),
  });
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

  const [combo, config, pack, catalogo, sesionesTotales, serviceId] = await Promise.all([
    obtenerCombo(db, linea.depilationComboId, sexo),
    leerConfig(db),
    zonasDelPack(db, linea.depilationComboId),
    zonasActivasDelCatalogo(db),
    sesionesTotalesDelPack(db, linea.purchaseId, linea.depilationComboId),
    anclaDeDepilacion(db),
  ]);
  if (!combo) throw notFound("Pack de depilación");

  const zonas = armarMenu(pack, catalogo, combo.choiceZoneCount, sexo, config);

  // La línea todavía está libre acá (recién se está por crear el turno), así
  // que ya se cuenta sola dentro de `libres` — ver `puertaDeLaLinea`.
  const puerta = await puertaDeLaLinea(db, {
    purchaseId: linea.purchaseId,
    esPaquete: linea.esPaquete,
    sesionesTotales,
    libres,
    lineaYaTomada: false,
  });

  return {
    nombreDelPack: linea.nombreDelPack,
    sesion: linea.repeticion,
    sesionesTotales,
    presupuestoMinutos: combo.duracionMinutos,
    zonasDeRegalo: combo.choiceZoneCount,
    sexo,
    zonas,
    puerta,
    serviceId,
  };
}
