import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  areaPackPolicy,
  categories,
  combos,
  comboService,
  customerPurchase,
  promotionTarget,
  service,
} from "../db/schema";
import { computeComboFinalPrice, computeComboSubtotal, precioDeServicio } from "../lib/combo-pricing";
import {
  agruparClasificaciones,
  type Clasificacion,
  type FilaDeClasificacion,
} from "../lib/clasificaciones-de-combo";
import { type ComboComparable, combosDuplicados } from "../lib/combo-duplicado";
import { precioPack } from "../lib/pack-pricing";
import { type PoliticaDeArea, politicaDeUnPack } from "../lib/politica-de-pack";
import {
  comboDelQueSalenLosServicios,
  type LineaDeCombo,
} from "../lib/servicios-comprados";

export type ComboLineInput = {
  serviceId: string;
  sessionsIncluded: number;
};

export type ComboHeaderInput = {
  name: string;
  description?: string | null;
  priceType: "fixed" | "percentage";
  fixedPrice?: number | null;
  discountPercentage?: number | null;
  validityMonths: number;
  isVisibleWeb?: boolean | null;
  displayOrder?: number | null;
  // ── 1.50.0 ───────────────────────────────────────────────────────────────
  /** El área. Obligatoria: se elige al crear, no se deduce de los servicios. */
  areaCategoryId: string;
  kind?: "combo" | "pack";
  /** Sólo en un pack que repite un combo. */
  packOfComboId?: string | null;
  packSessions?: number | null;
  packDiscountPercentage?: number | null;
  packRoundingBase?: number | null;
  /** Sólo en un combo: si los servicios se hacen en la misma visita. */
  servicesTogether?: boolean | null;
};

/** Lo que se puede editar de un combo ya guardado: el precio y la
 *  presentación, nunca la composición ni el área (spec §4.2). */
export type ComboEditInput = Omit<
  ComboHeaderInput,
  "areaCategoryId" | "kind" | "packOfComboId" | "packSessions"
>;

/** Drizzle espera los decimal como string. */
const dec = (v: number | null | undefined) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

const comboFields = {
  id: combos.id,
  name: combos.name,
  description: combos.description,
  priceType: combos.priceType,
  fixedPrice: combos.fixedPrice,
  discountPercentage: combos.discountPercentage,
  validityMonths: combos.validityMonths,
  isActive: combos.isActive,
  isVisibleWeb: combos.isVisibleWeb,
  displayOrder: combos.displayOrder,
  areaCategoryId: combos.areaCategoryId,
  kind: combos.kind,
  packOfComboId: combos.packOfComboId,
  packSessions: combos.packSessions,
  packDiscountPercentage: combos.packDiscountPercentage,
  packRoundingBase: combos.packRoundingBase,
  servicesTogether: combos.servicesTogether,
};

async function linesFor(db: Db, comboId: string) {
  return db
    .select({
      id: comboService.id,
      serviceId: comboService.serviceId,
      serviceName: service.name,
      serviceIsActive: service.isActive,
      sessionsIncluded: comboService.sessionsIncluded,
      servicePrice: comboService.servicePrice,
    })
    .from(comboService)
    .leftJoin(service, eq(comboService.serviceId, service.id))
    .where(eq(comboService.comboId, comboId));
}

/**
 * Arma la vista completa de un combo: sus líneas, el subtotal y el precio final.
 *
 * `hasInactiveService` es lo que usan el panel (para avisarle a Laura) y la
 * ruta pública (para no publicarlo). Publicar un paquete que incluye un
 * servicio que ya no se hace es peor que no publicarlo.
 */
export function assembleCombo(
  combo: Record<string, unknown>,
  lines: {
    id: string;
    serviceId: string | null;
    serviceName: string | null;
    serviceIsActive: boolean | null;
    sessionsIncluded: number | null;
    servicePrice: string | number | null;
  }[],
) {
  const priced = lines.map((l) => ({
    servicePrice: l.servicePrice != null ? Number(l.servicePrice) : 0,
    sessionsIncluded: l.sessionsIncluded ?? 0,
  }));
  const servicesSubtotal = computeComboSubtotal(priced);
  const finalAmount = computeComboFinalPrice(
    servicesSubtotal,
    (combo.priceType as string | null) ?? null,
    num(combo.fixedPrice),
    num(combo.discountPercentage),
  );

  return {
    ...combo,
    fixedPrice: num(combo.fixedPrice),
    discountPercentage: num(combo.discountPercentage),
    kind: (combo.kind as string | null) ?? "combo",
    servicesTogether: combo.servicesTogether === true,
    // Explícitas y no por el spread: `combo` entra como `Record<string,
    // unknown>`, así que al esparcirlo TypeScript no ve ninguna de estas
    // claves y todo lo que las lea después no compila.
    id: combo.id as string,
    areaCategoryId: (combo.areaCategoryId as string | null) ?? null,
    packOfComboId: (combo.packOfComboId as string | null) ?? null,
    packSessions: (combo.packSessions as number | null) ?? null,
    packDiscountPercentage: (combo.packDiscountPercentage as number | null) ?? null,
    packRoundingBase: (combo.packRoundingBase as number | null) ?? null,
    servicesSubtotal,
    // En un PACK esto se pisa después, en `conPrecioDePack`: el precio de un
    // pack no sale de sus renglones sino de repetir lo que apunta. Se deja
    // calculado igual para que un pack mal formado no muestre `undefined`.
    finalAmount,
    hasInactiveService: lines.some((l) => l.serviceIsActive === false),
    lines: lines.map((l) => ({
      id: l.id,
      serviceId: l.serviceId,
      serviceName: l.serviceName,
      serviceIsActive: l.serviceIsActive,
      sessionsIncluded: l.sessionsIncluded,
      servicePrice: num(l.servicePrice),
    })),
  };
}

/**
 * El tarifario de packs de cada área pedida, indexado por área.
 *
 * Un área sin fila en `area_pack_policy` simplemente no aparece en el mapa, y
 * sus packs se quedan sin precio calculado en vez de inventarle un descuento.
 */
async function politicasPorArea(db: Db, areaIds: string[]): Promise<Map<string, PoliticaDeArea>> {
  if (areaIds.length === 0) return new Map();
  const filas = await db
    .select({
      areaCategoryId: areaPackPolicy.areaCategoryId,
      packDiscountPercentage: areaPackPolicy.packDiscountPercentage,
      packRoundingBase: areaPackPolicy.packRoundingBase,
    })
    .from(areaPackPolicy)
    .where(inArray(areaPackPolicy.areaCategoryId, areaIds));

  const mapa = new Map<string, PoliticaDeArea>();
  for (const f of filas) {
    if (f.areaCategoryId == null) continue;
    mapa.set(f.areaCategoryId, {
      packDiscountPercentage: f.packDiscountPercentage ?? 0,
      packRoundingBase: f.packRoundingBase ?? 1,
    });
  }
  return mapa;
}

type FilaArmada = ReturnType<typeof assembleCombo>;

/**
 * Le pone precio a los packs de la lista.
 *
 * Un pack no se cotiza como un combo: su precio es **repetir N veces lo que
 * apunta** y aplicarle el descuento —el suyo si lo tiene, el de su área si no.
 *
 *   pack de un COMBO     base = el precio final de ese combo
 *   pack de un SERVICIO  base = el subtotal de su único renglón
 *
 * Se hace en una segunda pasada y no dentro de `assembleCombo` porque necesita
 * dos cosas que esa función no tiene a mano: el tarifario del área y el precio
 * del combo apuntado. Hacerlo fila por fila serían dos consultas por pack.
 *
 * No hay recursión posible: un pack sólo puede apuntar a un `kind='combo'`
 * (lo valida `validarPack`), así que la vuelta termina en un nivel.
 */
async function conPrecioDePack(db: Db, filas: FilaArmada[]): Promise<FilaArmada[]> {
  const packs = filas.filter((f) => f.kind === "pack");
  if (packs.length === 0) return filas;

  const areas = await politicasPorArea(db, [
    ...new Set(packs.map((p) => p.areaCategoryId).filter((x): x is string => !!x)),
  ]);

  // El precio de los combos que los packs repiten.
  const refIds = [...new Set(packs.map((p) => p.packOfComboId).filter((x): x is string => !!x))];
  const precioDelCombo = new Map<string, number>();
  for (const id of refIds) {
    const c = await getComboById(db, id);
    if (c) precioDelCombo.set(id, c.finalAmount);
  }

  return filas.map((f) => {
    if (f.kind !== "pack") return f;
    const area = f.areaCategoryId ? areas.get(f.areaCategoryId) : undefined;
    if (!area) return f;

    const politica = politicaDeUnPack(f, area);
    if (!politica) return f;

    const base = f.packOfComboId ? (precioDelCombo.get(f.packOfComboId) ?? 0) : f.servicesSubtotal;

    return {
      ...f,
      /** Lo que se repite, por unidad. Va al front para poder mostrar
       *  "4 × $12.000" y que se entienda de dónde sale el total. */
      packUnitAmount: base,
      finalAmount: precioPack(
        base,
        {
          packSesiones: politica.sesiones,
          packDescuentoPct: area.packDiscountPercentage,
          packRedondeo: area.packRoundingBase,
        },
        politica,
      ),
      /** De dónde salió el descuento, para que la pantalla lo diga. */
      packDiscountSource: f.packDiscountPercentage == null ? "area" : "propio",
      packEffectiveDiscount: politica.descuentoPct,
      /**
       * Por cuántas sesiones se multiplicó `finalAmount` recién acá arriba.
       *
       * No es lo mismo que `packSessions` y la diferencia es plata: cuando el
       * área no tiene tarifario (`if (!area) return f`) esta función se va sin
       * tocar el precio, y `packSessions` sigue diciendo 4 sobre un
       * `finalAmount` de UNA sesión. Quien tenga que expandir el pack en N
       * cosas a agendar —`lineasDeUnPaquete`, al vender un paquete de promo—
       * tiene que contar las MISMAS N que se cobraron, no las declaradas, o
       * cobra N y entrega 1 (o al revés).
       */
      packEffectiveSessions: politica.sesiones,
    };
  });
}

/** Congela el precio de lista de cada servicio elegido, igual que las promos. */
async function freezePrices(db: Db, lines: ComboLineInput[]) {
  const ids = lines.map((l) => l.serviceId);
  const priced = ids.length
    ? await db
        .select({
          id: service.id,
          priceList: service.unitPriceList,
          priceCash: service.unitPriceCash,
        })
        .from(service)
        .where(inArray(service.id, ids))
    : [];
  // Lista si hay, y si no efectivo: 79 de 213 servicios activos en producción
  // no tienen precio de lista. Ver precioDeServicio().
  const priceById = new Map(priced.map((p) => [p.id, precioDeServicio(p.priceList, p.priceCash)]));
  return lines.map((l) => ({ ...l, servicePrice: priceById.get(l.serviceId) ?? 0 }));
}

async function writeLines(
  db: Db,
  comboId: string,
  frozen: (ComboLineInput & { servicePrice: number })[],
) {
  await db.delete(comboService).where(eq(comboService.comboId, comboId));
  if (frozen.length === 0) return;
  await db.insert(comboService).values(
    frozen.map((l) => ({
      comboId,
      serviceId: l.serviceId,
      sessionsIncluded: l.sessionsIncluded,
      servicePrice: dec(l.servicePrice),
    })),
  );
}

export type FiltroDeCombos = {
  includeInactive?: boolean;
  /** Acota a un área. Cada solapa de Administración pasa la suya. */
  areaCategoryId?: string;
  /** `'combo'` para la solapa Combos, `'pack'` para la de Packs. */
  kind?: "combo" | "pack";
};

export async function listCombos(db: Db, filtro: FiltroDeCombos | boolean = {}) {
  // El segundo parámetro era un `includeInactive: boolean`. Se acepta todavía
  // para no romper a quien ya llamaba así (la ruta pública y sus tests).
  const f: FiltroDeCombos = typeof filtro === "boolean" ? { includeInactive: filtro } : filtro;

  const condiciones = [
    f.includeInactive ? undefined : ne(combos.isActive, false),
    f.areaCategoryId ? eq(combos.areaCategoryId, f.areaCategoryId) : undefined,
    f.kind ? eq(combos.kind, f.kind) : undefined,
  ].filter((c): c is Exclude<typeof c, undefined> => c !== undefined);

  const rows = await db
    .select(comboFields)
    .from(combos)
    .where(condiciones.length ? and(...condiciones) : undefined)
    .orderBy(asc(combos.displayOrder), asc(combos.name));

  const out = [];
  for (const c of rows) out.push(assembleCombo(c, await linesFor(db, c.id)));
  return conPrecioDePack(db, out);
}

export async function getComboById(db: Db, id: string) {
  const [c] = await db.select(comboFields).from(combos).where(eq(combos.id, id)).limit(1);
  if (!c) return null;
  const armado = assembleCombo(c, await linesFor(db, id));
  // Un combo no necesita la segunda pasada, y saltearla evita la consulta del
  // tarifario en el caso más común.
  if (armado.kind !== "pack") return armado;
  const [conPrecio] = await conPrecioDePack(db, [armado]);
  return conPrecio ?? armado;
}

/** Lo que ve la web: activo, visible, y con TODOS sus servicios activos. */
export async function listPublicCombos(db: Db) {
  const rows = await db
    .select(comboFields)
    .from(combos)
    .where(and(eq(combos.isActive, true), eq(combos.isVisibleWeb, true)))
    .orderBy(asc(combos.displayOrder), asc(combos.name));

  const out = [];
  for (const c of rows) {
    const assembled = assembleCombo(c, await linesFor(db, c.id));
    if (assembled.hasInactiveService) continue;
    // Un pack que repite un combo NO tiene renglones propios y aun así es
    // publicable: el filtro de "sin servicios" es para los combos vacíos.
    if (assembled.lines.length === 0 && !assembled.packOfComboId) continue;
    out.push(assembled);
  }
  // Sin esta pasada un pack se publicaría con el precio de sus renglones —
  // cero, si repite un combo— en vez del precio del pack.
  const conPrecio = await conPrecioDePack(db, out);
  return conAreaYClasificaciones(db, conPrecio);
}

/**
 * Le agrega a cada combo el NOMBRE de su área y sus clasificaciones.
 *
 * Son dos agrupaciones distintas y la web usa las dos: el área es el título
 * cuando se toca el botón "Combos"; las clasificaciones son los lugares del
 * árbol del menú donde el combo aparece. Ver el spec §2 — confundirlas es el
 * error fácil acá.
 *
 * Un PACK no tiene renglones propios: repite otro combo. Por eso los servicios
 * se buscan por `COALESCE(pack_of_combo_id, id)`, o un pack saldría sin
 * clasificaciones y desaparecería del árbol.
 */
async function conAreaYClasificaciones<T extends { id: string; areaCategoryId: string | null }>(
  db: Db,
  filas: T[],
): Promise<(T & { areaName: string | null; clasificaciones: Clasificacion[] })[]> {
  if (filas.length === 0) return [];
  const ids = filas.map((f) => f.id);

  const areaIds = [...new Set(filas.map((f) => f.areaCategoryId).filter((v): v is string => v != null))];
  const [areas, crudas] = await Promise.all([
    areaIds.length > 0
      ? db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(inArray(categories.id, areaIds))
      : Promise.resolve([] as { id: string; name: string }[]),
    // Sube desde cada categoría de cada servicio hasta la raíz, y se queda con
    // las raíces que no son áreas. `sube.origen` conserva de qué categoría se
    // partió, que es por donde engancha `service_category`.
    //
    // Los ids van expandidos a un parámetro cada uno (`IN ($1, $2, …)`) y NO
    // como un array en `= ANY($1)`. Bajo Hyperdrive el cliente corre con
    // `fetch_types: false`, y así postgres-js no puede averiguar el OID de un
    // array: lo aplasta a un escalar y Postgres contesta `malformed array
    // literal`. Eso dejó GET /api/agenda/combos en 500 el 2026-09-22.
    db.execute<{
      combo_id: string;
      clasificacion_id: string;
      clasificacion_name: string | null;
    }>(sql`
      WITH RECURSIVE sube AS (
        SELECT c.id, c.id AS origen, c.parent_category_id, c.kind, c.name
          FROM categories c
        UNION ALL
        SELECT p.id, sube.origen, p.parent_category_id, p.kind, p.name
          FROM categories p JOIN sube ON sube.parent_category_id = p.id
      )
      SELECT DISTINCT
             c.id   AS combo_id,
             sube.id   AS clasificacion_id,
             sube.name AS clasificacion_name
        FROM combos c
        JOIN combo_service cs ON cs.combo_id = COALESCE(c.pack_of_combo_id, c.id)
        JOIN service_category sc ON sc.service_id = cs.service_id
        JOIN sube ON sube.origen = sc.category_id
       WHERE sube.parent_category_id IS NULL
         AND sube.kind <> 'area'
         AND c.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `),
  ]);

  const nombreDeArea = new Map(areas.map((a) => [a.id, a.name]));
  const clasifs = agruparClasificaciones(
    [...crudas].map(
      (r): FilaDeClasificacion => ({
        comboId: r.combo_id,
        clasificacionId: r.clasificacion_id,
        clasificacionName: r.clasificacion_name,
      }),
    ),
  );

  return filas.map((f) => ({
    ...f,
    areaName: f.areaCategoryId ? (nombreDeArea.get(f.areaCategoryId) ?? null) : null,
    clasificaciones: clasifs.get(f.id) ?? [],
  }));
}

/**
 * Las dos reglas del pack que un CHECK no puede pedir.
 *
 * Las dos necesitan mirar OTRA fila, y un CHECK sólo ve la suya. Se validan acá
 * y no en la ruta porque son invariantes de la base, no de una pantalla: quien
 * cree un pack desde otro lado tiene que chocar con lo mismo.
 *
 * Devuelve el motivo, o `null` si está bien.
 */
export async function validarPack(
  db: Db,
  header: ComboHeaderInput,
  lines: ComboLineInput[],
): Promise<string | null> {
  if ((header.kind ?? "combo") !== "pack") return null;

  const apuntaACombo = !!header.packOfComboId;
  const tieneRenglones = lines.length > 0;

  // Un pack repite UNA cosa. Con las dos cargadas no hay forma de decir cuál
  // es el precio base, y con ninguna no hay nada que repetir.
  if (apuntaACombo && tieneRenglones) {
    return "Un pack repite un combo o servicios sueltos, no las dos cosas a la vez";
  }
  if (!apuntaACombo && !tieneRenglones) {
    return "El pack necesita un combo al que apuntar o al menos un servicio";
  }

  if (apuntaACombo) {
    const [ref] = await db
      .select({ kind: combos.kind, areaCategoryId: combos.areaCategoryId, isActive: combos.isActive })
      .from(combos)
      .where(eq(combos.id, header.packOfComboId!))
      .limit(1);

    if (!ref) return "El combo que el pack repite no existe";
    // No hay packs de packs: un pack de un pack de un combo daría dos
    // multiplicaciones encadenadas y un precio que nadie puede explicar.
    if (ref.kind === "pack") return "Un pack no puede repetir a otro pack";
    if (ref.areaCategoryId !== header.areaCategoryId) {
      return "El pack y el combo que repite tienen que ser de la misma área";
    }
    if (ref.isActive === false) return "No se puede armar un pack de un combo archivado";
  }

  return null;
}

/**
 * Los combos y packs del área, en la forma que compara `combo-duplicado.ts`.
 *
 * Trae también los archivados: un duplicado de algo archivado sigue siendo un
 * duplicado, y avisarlo le deja a Laura la opción de desarchivar en vez de
 * cargar lo mismo de nuevo.
 */
export async function comparablesDeArea(db: Db, areaCategoryId: string): Promise<ComboComparable[]> {
  const filas = await db
    .select({
      id: combos.id,
      name: combos.name,
      areaCategoryId: combos.areaCategoryId,
      kind: combos.kind,
      packOfComboId: combos.packOfComboId,
      packSessions: combos.packSessions,
    })
    .from(combos)
    .where(eq(combos.areaCategoryId, areaCategoryId));

  const ids = filas.map((f) => f.id);
  const renglones = ids.length
    ? await db
        .select({ comboId: comboService.comboId, serviceId: comboService.serviceId })
        .from(comboService)
        .where(inArray(comboService.comboId, ids))
    : [];

  const serviciosDe = new Map<string, string[]>();
  for (const r of renglones) {
    if (!r.comboId || !r.serviceId) continue;
    const lista = serviciosDe.get(r.comboId) ?? [];
    lista.push(r.serviceId);
    serviciosDe.set(r.comboId, lista);
  }

  return filas.map((f) => ({
    id: f.id,
    name: f.name ?? "",
    areaCategoryId: f.areaCategoryId ?? "",
    kind: f.kind === "pack" ? "pack" : "combo",
    packOfComboId: f.packOfComboId ?? null,
    packSessions: f.packSessions ?? null,
    serviceIds: serviciosDe.get(f.id) ?? [],
  }));
}

/**
 * Qué ya existe igual a lo que se está por crear.
 *
 * Es un AVISO: quien está cargando decide si sigue. Bloquear obligaría a
 * adivinar los casos legítimos que todavía no aparecieron.
 */
export async function duplicadosDe(
  db: Db,
  header: ComboHeaderInput,
  lines: ComboLineInput[],
  idPropio = "",
): Promise<{ id: string; name: string }[]> {
  const candidato: ComboComparable = {
    id: idPropio,
    name: header.name,
    areaCategoryId: header.areaCategoryId,
    kind: header.kind === "pack" ? "pack" : "combo",
    packOfComboId: header.packOfComboId ?? null,
    packSessions: header.packSessions ?? null,
    serviceIds: lines.map((l) => l.serviceId),
  };
  const existentes = await comparablesDeArea(db, header.areaCategoryId);
  return combosDuplicados(candidato, existentes).map((c) => ({ id: c.id, name: c.name }));
}

/** Cuántas compras apuntan a este combo. Cero permite el borrado real. */
export async function comprasDeCombo(db: Db, id: string): Promise<number> {
  const filas = await db
    .select({ id: customerPurchase.id })
    .from(customerPurchase)
    .where(eq(customerPurchase.comboId, id));
  return filas.length;
}

/** Los packs que repiten este combo. Borrarlo los dejaría sin base de precio. */
export async function packsDeCombo(db: Db, id: string): Promise<{ id: string; name: string }[]> {
  const filas = await db
    .select({ id: combos.id, name: combos.name })
    .from(combos)
    .where(eq(combos.packOfComboId, id));
  return filas.map((f) => ({ id: f.id, name: f.name ?? "" }));
}

/**
 * `writeLines` borra todas las líneas del combo y las vuelve a insertar: sin
 * transacción, si el INSERT falla después del DELETE el combo queda activo,
 * visible y vacío (0 servicios, $0), sin forma de deshacerlo. Por eso todo el
 * alta va en una única transacción.
 */
export async function createCombo(db: Db, header: ComboHeaderInput, lines: ComboLineInput[]) {
  const createdId = await db.transaction(async (tx) => {
    const frozen = await freezePrices(tx, lines);
    const [created] = await tx
      .insert(combos)
      .values({
        name: header.name,
        description: header.description ?? null,
        priceType: header.priceType,
        fixedPrice: dec(header.fixedPrice ?? null),
        discountPercentage: dec(header.discountPercentage ?? null),
        validityMonths: header.validityMonths,
        isActive: true,
        isVisibleWeb: header.isVisibleWeb ?? true,
        displayOrder: header.displayOrder ?? 0,
        areaCategoryId: header.areaCategoryId,
        kind: header.kind ?? "combo",
        packOfComboId: header.packOfComboId ?? null,
        packSessions: header.packSessions ?? null,
        packDiscountPercentage: header.packDiscountPercentage ?? null,
        packRoundingBase: header.packRoundingBase ?? null,
        // Un pack nunca lo lleva (lo prohíbe `ck_combos_pack`): si repite un
        // combo, el dato sale del combo apuntado.
        servicesTogether: header.kind === "pack" ? false : (header.servicesTogether ?? false),
      })
      .returning({ id: combos.id });
    if (!created) return null;
    await writeLines(tx, created.id, frozen);
    return created.id;
  });
  if (!createdId) return null;
  // getComboById va DESPUÉS del commit, no adentro de la transacción: es una
  // lectura de lo que ya quedó confirmado, y no tiene sentido alargar el
  // bloqueo de la transacción con un SELECT que no necesita ver datos "en
  // vuelo" ni participar del rollback.
  return getComboById(db, createdId);
}

/**
 * Edita el precio y la presentación. **La composición NO se toca.**
 *
 * Decisión de Pia (spec §4.2): *"La composición de un combo no se edita: sólo
 * su precio."* Cambiar qué servicios lo forman lo convierte en otro producto y
 * deja a las compras viejas apuntando a algo que no es lo que se vendió. Y un
 * pack apunta a su combo justamente porque la composición no cambia — si
 * cambiara, el pack estaría repitiendo otra cosa sin enterarse.
 *
 * Por eso ya no recibe `lines` ni `areaCategoryId`, y desapareció el
 * DELETE + INSERT de renglones que hacía antes. Si el combo se cargó mal, se
 * borra —mientras no tenga compras— y se rehace.
 */
export async function updateCombo(db: Db, id: string, header: ComboEditInput) {
  const updated = await db
    .update(combos)
    .set({
      name: header.name,
      description: header.description ?? null,
      priceType: header.priceType,
      fixedPrice: dec(header.fixedPrice ?? null),
      discountPercentage: dec(header.discountPercentage ?? null),
      validityMonths: header.validityMonths,
      isVisibleWeb: header.isVisibleWeb ?? true,
      displayOrder: header.displayOrder ?? 0,
      packDiscountPercentage: header.packDiscountPercentage ?? null,
      packRoundingBase: header.packRoundingBase ?? null,
      servicesTogether: header.servicesTogether ?? false,
    })
    .where(eq(combos.id, id))
    .returning({ id: combos.id });
  if (updated.length === 0) return null;
  return getComboById(db, id);
}

export async function setComboStatus(db: Db, id: string, isActive: boolean) {
  const rows = await db
    .update(combos)
    .set({ isActive })
    .where(eq(combos.id, id))
    .returning({ id: combos.id });
  if (rows.length === 0) return null;
  return getComboById(db, id);
}

/**
 * Las dos guardas del borrado real, que pedía la fase 2.
 *
 * Borrar es la salida cuando un combo se cargó mal: como la composición no se
 * edita (`updateCombo`), lo que se hace es borrarlo y rehacerlo. Eso vale
 * **mientras nadie lo haya comprado**; después sólo se archiva, porque una
 * compra vieja tiene que poder seguir explicando qué se vendió.
 *
 * Vive en su propia función porque la usan los DOS lados —el preview y el
 * DELETE— y que digan cosas distintas sería peor que no tener preview.
 *
 * Devuelve el motivo del rechazo, o `undefined` si se puede borrar.
 */
async function motivoParaNoBorrarCombo(db: Db, id: string): Promise<string | undefined> {
  const compras = await comprasDeCombo(db, id);
  if (compras > 0) {
    return compras === 1
      ? "No se puede borrar: hay 1 compra de este combo. Archivalo en vez de borrarlo."
      : `No se puede borrar: hay ${compras} compras de este combo. Archivalo en vez de borrarlo.`;
  }

  // La FK es ON DELETE RESTRICT, así que la base lo frenaría igual — pero con
  // un error de constraint que no dice cuáles son. Nombrarlos evita que Laura
  // tenga que adivinar qué borrar primero.
  const packs = await packsDeCombo(db, id);
  if (packs.length > 0) {
    return `No se puede borrar: hay packs que lo repiten (${packs.map((p) => p.name).join(", ")}). Borrá esos packs primero.`;
  }

  return undefined;
}

/**
 * Qué se lleva puesto borrar un combo o un pack, ANTES de confirmarlo.
 *
 * Existe por lo que pasó al arreglar el borrado: desde que
 * `deleteComboPermanently` limpia `promotion_target`, el DELETE **funciona** —
 * y sin este preview el cartel decía que no había nada colgando mientras la
 * promo perdía ese destino en silencio. Si era su único destino, la promo
 * queda viva pero inerte: no aplica a nada. Antes la base lo frenaba con un
 * error de constraint; feo, pero frenaba.
 *
 * Las mismas dos guardas que usa el borrado (`motivoParaNoBorrarCombo`), para
 * que el preview y el DELETE nunca digan cosas distintas.
 */
export async function getComboDeleteImpact(db: Db, id: string) {
  const [blockReason, lineas, ofertas] = await Promise.all([
    motivoParaNoBorrarCombo(db, id),
    db.select({ id: comboService.id }).from(comboService).where(eq(comboService.comboId, id)),
    db.select({ id: promotionTarget.id }).from(promotionTarget).where(eq(promotionTarget.comboId, id)),
  ]);

  return {
    blocked: blockReason != null,
    blockReason,
    cascade: { servicios: lineas.length, promoTargets: ofertas.length },
  };
}

/** Borra el combo (o el pack) y todo lo que colgaba de él. El caller debería
 *  haber mirado `getComboDeleteImpact` antes, pero las guardas se revalidan
 *  acá: entre el preview y el DELETE alguien pudo comprarlo.
 *
 *  Devuelve el motivo del rechazo, o `null` si borró. */
export async function deleteComboPermanently(db: Db, id: string): Promise<string | null> {
  const motivo = await motivoParaNoBorrarCombo(db, id);
  if (motivo) return motivo;

  await db.delete(comboService).where(eq(comboService.comboId, id));
  // Y lo que este combo tuviera en oferta. `promotion_target.combo_id` es NO
  // ACTION: sin esto, un combo que Laura puso en una promo no se borra nunca
  // —la base responde con un error de constraint que no nombra a la promo—.
  // Un pack de catálogo es una fila de `combos`, así que cubre a los dos.
  await db.delete(promotionTarget).where(eq(promotionTarget.comboId, id));
  const result = await db.delete(combos).where(eq(combos.id, id)).returning({ id: combos.id });
  return result.length > 0 ? null : "El combo no existe";
}

// ── El tarifario de packs por área (1.50.0) ─────────────────────────────────

export type TarifarioDeArea = {
  areaCategoryId: string;
  areaName: string | null;
  packSessions: number;
  packDiscountPercentage: number;
  packRoundingBase: number;
};

/**
 * El tarifario de todas las áreas que tienen uno, con el nombre del área.
 *
 * La 1.50.0 siembra las tres de catálogo; depilación no está porque usa
 * `depilation_pricing_config`, su propio motor.
 */
export async function listarTarifarios(db: Db): Promise<TarifarioDeArea[]> {
  const filas = await db
    .select({
      areaCategoryId: areaPackPolicy.areaCategoryId,
      areaName: categories.name,
      packSessions: areaPackPolicy.packSessions,
      packDiscountPercentage: areaPackPolicy.packDiscountPercentage,
      packRoundingBase: areaPackPolicy.packRoundingBase,
    })
    .from(areaPackPolicy)
    .leftJoin(categories, eq(categories.id, areaPackPolicy.areaCategoryId))
    .orderBy(asc(categories.name));

  return filas
    .filter((f): f is typeof f & { areaCategoryId: string } => f.areaCategoryId != null)
    .map((f) => ({
      areaCategoryId: f.areaCategoryId,
      areaName: f.areaName,
      packSessions: f.packSessions ?? 0,
      packDiscountPercentage: f.packDiscountPercentage ?? 0,
      packRoundingBase: f.packRoundingBase ?? 1,
    }));
}

/**
 * Cambia el tarifario de un área, o lo crea si el área todavía no tenía.
 *
 * **No toca los packs ya guardados**, y es a propósito: un pack con descuento
 * propio lo conserva, y uno que seguía la política del área pasa a mostrar la
 * nueva. Los precios ya VENDIDOS tampoco se mueven — `customer_purchase`
 * congela su total al comprar.
 */
export async function guardarTarifario(
  db: Db,
  areaCategoryId: string,
  valores: { packSessions: number; packDiscountPercentage: number; packRoundingBase: number },
): Promise<TarifarioDeArea | null> {
  const [ya] = await db
    .select({ id: areaPackPolicy.id })
    .from(areaPackPolicy)
    .where(eq(areaPackPolicy.areaCategoryId, areaCategoryId))
    .limit(1);

  if (ya) {
    await db
      .update(areaPackPolicy)
      .set({ ...valores, updatedAt: new Date() })
      .where(eq(areaPackPolicy.areaCategoryId, areaCategoryId));
  } else {
    await db.insert(areaPackPolicy).values({ areaCategoryId, ...valores });
  }

  const todos = await listarTarifarios(db);
  return todos.find((t) => t.areaCategoryId === areaCategoryId) ?? null;
}

/**
 * Los servicios que hay que agendar al vender este combo.
 *
 * Un PACK no tiene renglones propios cuando repite un combo: sus servicios son
 * los de ese combo. Si tiene renglones propios (un pack de un servicio suelto),
 * son los suyos. La validación de que es uno u otro, no los dos, ya la hace
 * `validarPack`.
 */
export async function lineasParaVender(db: Db, comboId: string): Promise<LineaDeCombo[]> {
  const [c] = await db
    .select({ kind: combos.kind, packOfComboId: combos.packOfComboId })
    .from(combos)
    .where(eq(combos.id, comboId))
    .limit(1);
  if (!c) return [];

  const origen = comboDelQueSalenLosServicios(c.kind, c.packOfComboId, comboId);
  const lineas = await linesFor(db, origen);
  return lineas
    .filter((l): l is typeof l & { serviceId: string } => l.serviceId != null)
    .map((l) => ({
      serviceId: l.serviceId,
      sessionsIncluded: l.sessionsIncluded ?? 1,
      // El precio congelado del renglón. Es el mismo con el que se calculó el
      // subtotal del combo, así que las partes suman exactamente el precio
      // que la clienta pagó (1.52.0).
      price: l.servicePrice == null ? null : Number(l.servicePrice),
    }));
}
