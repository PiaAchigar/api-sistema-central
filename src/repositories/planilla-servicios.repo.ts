import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  categories,
  combos,
  comboService,
  machines,
  priceAdjustmentItems,
  priceAdjustments,
  products,
  service,
  serviceCategory,
  serviceMachine,
  serviceProduct,
  serviceProviders,
  serviceProviderService,
} from "../db/schema";
import { AppError, notFound } from "../lib/errors";
import { todayLocal } from "../lib/time";
import {
  buscar,
  CODIGO_A_TIPO_DE_PAGO,
  planificarPlanilla,
  TIPOS_DE_PAGO,
  type Catalogo,
  type ContenidoPlanilla,
  type EntradaPlanilla,
  type ErrorDePlanilla,
  type ListasPlanilla,
  type PlanDePlanilla,
  type PlanillaDescarga,
  type Previsualizacion,
  type ServicioNormalizado,
} from "../lib/planilla-servicios";

// Leer, previsualizar y aplicar la planilla de servicios de un área.
// La lógica de qué cambia vive en lib/planilla-servicios.ts; acá sólo se lee la base,
// se le pasa al planificador y se ejecuta el plan en UNA transacción.

/** Categorías que existen pero no se tildan a mano (copia de la lista del front: no se puede importar). */
export const NO_SE_TILDAN = ["Promos del Mes", "Combos"];

/** 400 que lleva los errores de la planilla, con pestaña y fila. La ruta responde `{ error, errores }`. */
export class ErroresDePlanilla extends AppError {
  constructor(public readonly errores: ErrorDePlanilla[]) {
    super(400, "La planilla tiene errores. No se guardó nada.");
    this.name = "ErroresDePlanilla";
  }
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const money = (v: number | null): string | null => (v === null ? null : v.toFixed(2));
const sino = (v: boolean | null): string => (v ? "Sí" : "No");
const SEP = " › ";

// ───────────────────────── Catálogo ─────────────────────────

/** Mapa nombre → id; `null` si el nombre se repite (no se sabe cuál es). */
function mapaDeNombres(filas: { id: string; name: string | null }[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const f of filas) {
    const n = (f.name ?? "").trim();
    if (n === "") continue;
    m.set(n, m.has(n) ? null : f.id);
  }
  return m;
}

async function buscarArea(db: Db, nombre: string): Promise<{ id: string; nombre: string }> {
  const [a] = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.kind, "area"), eq(categories.name, nombre)))
    .limit(1);
  if (!a) throw notFound("Área");
  return { id: a.id, nombre: a.name ?? nombre };
}

type CategoriaFila = { id: string; parent: string | null; name: string | null; kind: string; activa: boolean };

/** Ruta "Madre › Hija" de cada categoría (con un tope por si hubiera un ciclo). */
function rutasDeCategorias(todas: CategoriaFila[]): Map<string, string> {
  const porId = new Map(todas.map((c) => [c.id, c]));
  const rutas = new Map<string, string>();
  for (const c of todas) {
    const partes: string[] = [];
    let cur: CategoriaFila | undefined = c;
    for (let i = 0; cur && i < 20; i++) {
      partes.unshift((cur.name ?? "").trim());
      cur = cur.parent ? porId.get(cur.parent) : undefined;
    }
    rutas.set(c.id, partes.join(SEP));
  }
  return rutas;
}

/** ¿Es el nodo, o cuelga de, un área o de algo que no se tilda? */
function estaExcluida(c: CategoriaFila, porId: Map<string, CategoriaFila>): boolean {
  let cur: CategoriaFila | undefined = c;
  for (let i = 0; cur && i < 20; i++) {
    if (cur.kind === "area" || NO_SE_TILDAN.includes(cur.name ?? "")) return true;
    cur = cur.parent ? porId.get(cur.parent) : undefined;
  }
  return false;
}

async function leerCatalogo(db: Db, areaId: string): Promise<{ catalogo: Catalogo; listas: ListasPlanilla }> {
  const [maqs, provs, prods, cats, delArea] = await Promise.all([
    db.select({ id: machines.id, name: machines.name }).from(machines).where(eq(machines.status, "active")),
    db.select({ id: serviceProviders.id, name: serviceProviders.fullName }).from(serviceProviders).where(eq(serviceProviders.status, "active")),
    db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(eq(products.isActive, true), eq(products.isSupply, true))),
    db
      .select({
        id: categories.id,
        parent: categories.parentCategoryId,
        name: categories.name,
        kind: categories.kind,
        activa: categories.isActive,
      })
      .from(categories),
    db
      .selectDistinct({ id: service.id })
      .from(service)
      .innerJoin(serviceCategory, eq(serviceCategory.serviceId, service.id))
      .where(and(eq(serviceCategory.categoryId, areaId), eq(service.isActive, true), sql`COALESCE(${service.noVendible}, false) = false`)),
  ]);

  const todas: CategoriaFila[] = cats.map((c) => ({ ...c, activa: c.activa === true }));
  const porId = new Map(todas.map((c) => [c.id, c]));
  const rutas = rutasDeCategorias(todas);
  const tildables = todas.filter((c) => c.activa && !estaExcluida(c, porId));
  const catMapa = mapaDeNombres(tildables.map((c) => ({ id: c.id, name: rutas.get(c.id) ?? c.name })));

  const catalogo: Catalogo = {
    maquinas: mapaDeNombres(maqs),
    proveedoras: mapaDeNombres(provs),
    insumos: mapaDeNombres(prods),
    categorias: catMapa,
    idsDelArea: new Set(delArea.map((s) => s.id)),
  };
  const ordenadas = (m: Map<string, string | null>) => [...m.keys()].sort((a, b) => a.localeCompare(b, "es"));
  const listas: ListasPlanilla = {
    maquinas: ordenadas(catalogo.maquinas),
    proveedoras: ordenadas(catalogo.proveedoras),
    insumos: ordenadas(catalogo.insumos),
    categorias: ordenadas(catMapa),
    tiposDePago: [...TIPOS_DE_PAGO],
  };
  return { catalogo, listas };
}

export async function cargarCatalogo(db: Db, areaId: string): Promise<Catalogo> {
  return (await leerCatalogo(db, areaId)).catalogo;
}

// ───────────────────────── Leer ─────────────────────────

async function leerContenido(db: Db, areaId: string): Promise<ContenidoPlanilla> {
  const servicios = await db
    .selectDistinct({
      id: service.id,
      name: service.name,
      code: service.code,
      description: service.description,
      lista: service.unitPriceList,
      efectivo: service.unitPriceCash,
      duracion: service.estimatedDurationMinutes,
      unidad: service.unitType,
      operadora: service.requiresOperator,
      maquina: service.requiresMachine,
      visible: service.isVisible,
      destacado: service.isFeatured,
      orden: service.webSortOrder,
      beneficios: service.benefits,
      contra: service.contraindications,
      instrucciones: service.specialAttentionNotes,
    })
    .from(service)
    .innerJoin(serviceCategory, eq(serviceCategory.serviceId, service.id))
    .where(and(eq(serviceCategory.categoryId, areaId), eq(service.isActive, true), sql`COALESCE(${service.noVendible}, false) = false`))
    .orderBy(asc(service.name), asc(service.id));

  const ids = servicios.map((s) => s.id);
  const nombreDe = new Map(servicios.map((s) => [s.id, s.name ?? ""]));
  const vacio: ContenidoPlanilla = { servicios: [], acuerdos: [], insumos: [], categorias: [] };
  if (ids.length === 0) return vacio;

  const [maqs, acus, ins, cats, todas] = await Promise.all([
    db
      .select({ serviceId: serviceMachine.serviceId, name: machines.name })
      .from(serviceMachine)
      .innerJoin(machines, eq(machines.id, serviceMachine.machineId))
      .where(and(inArray(serviceMachine.serviceId, ids), eq(serviceMachine.isPrimaryMachine, true))),
    db
      .select({
        serviceId: serviceProviderService.serviceId,
        proveedora: serviceProviders.fullName,
        tipo: serviceProviderService.paymentType,
        rate: serviceProviderService.rate,
      })
      .from(serviceProviderService)
      .innerJoin(serviceProviders, eq(serviceProviders.id, serviceProviderService.serviceProviderId))
      .where(and(inArray(serviceProviderService.serviceId, ids), eq(serviceProviderService.isActive, true))),
    db
      .select({ serviceId: serviceProduct.serviceId, insumo: products.name, quantity: serviceProduct.quantity })
      .from(serviceProduct)
      .innerJoin(products, eq(products.id, serviceProduct.productId))
      .where(inArray(serviceProduct.serviceId, ids)),
    db
      .select({ serviceId: serviceCategory.serviceId, categoryId: serviceCategory.categoryId })
      .from(serviceCategory)
      .where(inArray(serviceCategory.serviceId, ids)),
    db
      .select({ id: categories.id, parent: categories.parentCategoryId, name: categories.name, kind: categories.kind })
      .from(categories),
  ]);

  const maqDe = new Map<string, string>();
  for (const m of maqs) if (m.serviceId && !maqDe.has(m.serviceId)) maqDe.set(m.serviceId, m.name ?? "");

  const orden = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "", "es");
  const posicion = new Map(ids.map((id, i) => [id, i]));
  const porServicio = <T extends { serviceId: string | null }>(a: T, b: T) =>
    (posicion.get(a.serviceId ?? "") ?? 0) - (posicion.get(b.serviceId ?? "") ?? 0);

  const cat = todas.map((c) => ({ ...c, activa: true }));
  const rutas = rutasDeCategorias(cat);
  const esArea = new Set(todas.filter((c) => c.kind === "area").map((c) => c.id));

  return {
    servicios: servicios.map((s, i) => ({
      fila: i + 2,
      id: s.id,
      nombre: s.name,
      codigo: s.code,
      descripcion: s.description,
      precioLista: num(s.lista),
      precioEfectivo: num(s.efectivo),
      duracion: s.duracion,
      unidad: s.unidad,
      requiereOperadora: sino(s.operadora),
      requiereMaquina: sino(s.maquina),
      maquina: maqDe.get(s.id) ?? null,
      visibleWeb: sino(s.visible),
      destacado: sino(s.destacado),
      ordenWeb: s.orden,
      beneficios: s.beneficios,
      contraindicaciones: s.contra,
      instrucciones: s.instrucciones,
    })),
    acuerdos: acus
      .sort((a, b) => porServicio(a, b) || orden(a.proveedora, b.proveedora))
      .map((a, i) => ({
        fila: i + 2,
        servicio: nombreDe.get(a.serviceId ?? "") ?? "",
        proveedora: a.proveedora,
        tipoDePago: CODIGO_A_TIPO_DE_PAGO[a.tipo ?? ""] ?? a.tipo,
        tarifa: num(a.rate),
      })),
    insumos: ins
      .sort((a, b) => porServicio(a, b) || orden(a.insumo, b.insumo))
      .map((r, i) => ({
        fila: i + 2,
        servicio: nombreDe.get(r.serviceId ?? "") ?? "",
        insumo: r.insumo,
        cantidad: num(r.quantity),
      })),
    categorias: cats
      .filter((c) => c.categoryId && !esArea.has(c.categoryId))
      .map((c) => ({ serviceId: c.serviceId, ruta: rutas.get(c.categoryId as string) ?? "" }))
      .sort((a, b) => porServicio(a, b) || orden(a.ruta, b.ruta))
      .map((c, i) => ({ fila: i + 2, servicio: nombreDe.get(c.serviceId ?? "") ?? "", categoria: c.ruta })),
  };
}

export async function leerPlanilla(db: Db, areaNombre: string): Promise<PlanillaDescarga> {
  const area = await buscarArea(db, areaNombre);
  const [contenido, { listas }] = await Promise.all([leerContenido(db, area.id), leerCatalogo(db, area.id)]);
  return { area, generadaEn: new Date().toISOString(), contenido, listas };
}

// ───────────────────────── Previsualizar ─────────────────────────

const TOCA_PRECIO = (patch: Partial<ServicioNormalizado>) => "unitPriceList" in patch || "unitPriceCash" in patch;

async function combosQueContienen(db: Db, serviceIds: string[]): Promise<Previsualizacion["combosAfectados"]> {
  if (serviceIds.length === 0) return [];
  const cs = await db
    .selectDistinct({ id: combos.id, name: combos.name, kind: combos.kind })
    .from(combos)
    .innerJoin(comboService, eq(comboService.comboId, combos.id))
    .where(and(eq(combos.isActive, true), inArray(comboService.serviceId, serviceIds)))
    .orderBy(combos.name);
  return cs.map((c) => ({ id: c.id, nombre: c.name ?? "", kind: c.kind === "pack" ? "pack" : "combo" }));
}

export async function previsualizarPlanilla(db: Db, e: EntradaPlanilla): Promise<Previsualizacion> {
  const area = await buscarArea(db, e.area);
  const [actual, catalogo] = await Promise.all([leerContenido(db, area.id), cargarCatalogo(db, area.id)]);
  const { plan, vista } = planificarPlanilla({ original: e.original, editada: e.editada, actual, catalogo });
  const combosAfectados = await combosQueContienen(
    db,
    plan.actualizar.filter((a) => TOCA_PRECIO(a.patch)).map((a) => a.id),
  );
  return { ...vista, combosAfectados };
}

// ───────────────────────── Aplicar ─────────────────────────

/** Columnas de `service` que salen de un servicio normalizado (sin la máquina, que es otra tabla). */
function columnasDeServicio(p: Partial<ServicioNormalizado>) {
  const set: Partial<typeof service.$inferInsert> = {};
  if ("name" in p) set.name = p.name ?? null;
  if ("code" in p) set.code = p.code ?? null;
  if ("description" in p) set.description = p.description ?? null;
  if ("unitPriceList" in p) set.unitPriceList = money(p.unitPriceList ?? null);
  if ("unitPriceCash" in p) set.unitPriceCash = money(p.unitPriceCash ?? null);
  if ("estimatedDurationMinutes" in p) set.estimatedDurationMinutes = p.estimatedDurationMinutes ?? null;
  if ("unitType" in p) set.unitType = p.unitType ?? null;
  if ("requiresOperator" in p) set.requiresOperator = p.requiresOperator ?? null;
  if ("requiresMachine" in p) set.requiresMachine = p.requiresMachine ?? null;
  if ("isVisible" in p) set.isVisible = p.isVisible ?? null;
  if ("isFeatured" in p) set.isFeatured = p.isFeatured ?? null;
  // web_sort_order es NOT NULL DEFAULT 0: null explícito rompe.
  if ("webSortOrder" in p) set.webSortOrder = p.webSortOrder ?? 0;
  if ("benefits" in p) set.benefits = p.benefits ?? null;
  if ("contraindications" in p) set.contraindications = p.contraindications ?? null;
  if ("specialAttentionNotes" in p) set.specialAttentionNotes = p.specialAttentionNotes ?? null;
  return set;
}

/** Misma lógica que `setServicePrimaryMachine` (una máquina principal por servicio), sobre la transacción. */
async function ponerMaquinaPrincipal(db: Db, serviceId: string, nombre: string | null, catalogo: Catalogo) {
  await db.delete(serviceMachine).where(eq(serviceMachine.serviceId, serviceId));
  if (nombre === null) return;
  const machineId = buscar(catalogo.maquinas, nombre);
  if (!machineId) throw new Error(`Máquina «${nombre}» sin resolver`); // el planificador ya lo validó
  await db.insert(serviceMachine).values({ serviceId, machineId, isPrimaryMachine: true });
}

async function ejecutarPlan(db: Db, plan: PlanDePlanilla, areaId: string, catalogo: Catalogo, usuario: { id: string | null; email: string | null }) {
  const hoy = todayLocal();
  const idNuevo = new Map<number, string>(); // fila de la planilla → id del servicio creado
  const idDe = (ref: { id: string } | { nuevaFila: number }): string => {
    if ("id" in ref) return ref.id;
    const id = idNuevo.get(ref.nuevaFila);
    if (!id) throw new Error(`Servicio nuevo de la fila ${ref.nuevaFila} sin crear`);
    return id;
  };

  // Nuevos: tax_category queda null (el IVA no va en la planilla) y entran al área.
  for (const c of plan.crear) {
    const [fila] = await db
      .insert(service)
      .values({ ...columnasDeServicio(c.datos), taxCategory: null, isActive: true, noVendible: false })
      .returning({ id: service.id });
    if (!fila) throw new Error("No se pudo crear el servicio");
    idNuevo.set(c.fila, fila.id);
    await db.insert(serviceCategory).values({ serviceId: fila.id, categoryId: areaId });
    if (c.datos.maquina !== null) await ponerMaquinaPrincipal(db, fila.id, c.datos.maquina, catalogo);
  }

  // Modificados.
  const items: { serviceId: string; listBefore: number | null; listAfter: number | null; cashBefore: number | null; cashAfter: number | null }[] = [];
  for (const a of plan.actualizar) {
    const set = columnasDeServicio(a.patch);
    await db.update(service).set({ ...set, updatedAt: new Date() }).where(eq(service.id, a.id));
    if ("maquina" in a.patch) await ponerMaquinaPrincipal(db, a.id, a.patch.maquina ?? null, catalogo);
    if (TOCA_PRECIO(a.patch)) {
      const antes = a.precioAntes ?? { lista: null, efectivo: null };
      items.push({
        serviceId: a.id,
        listBefore: antes.lista,
        listAfter: "unitPriceList" in a.patch ? (a.patch.unitPriceList ?? null) : antes.lista,
        cashBefore: antes.efectivo,
        cashAfter: "unitPriceCash" in a.patch ? (a.patch.unitPriceCash ?? null) : antes.efectivo,
      });
    }
  }

  // Acuerdos: nunca se cierra por ausencia, sólo el vigente del par que cambió.
  for (const ac of plan.acuerdos) {
    const serviceId = idDe(ac.servicio);
    if (ac.cerrarVigente) {
      await db
        .update(serviceProviderService)
        .set({ isActive: false, validUntil: hoy })
        .where(
          and(
            eq(serviceProviderService.serviceId, serviceId),
            eq(serviceProviderService.serviceProviderId, ac.proveedoraId),
            eq(serviceProviderService.isActive, true),
          ),
        );
    }
    await db.insert(serviceProviderService).values({
      serviceProviderId: ac.proveedoraId,
      serviceId,
      paymentType: ac.paymentType,
      rate: money(ac.rate),
      validFrom: hoy,
      isActive: true,
    });
  }

  // Insumos: alta o cambio de cantidad; nunca se borra una receta.
  for (const i of plan.insumos) {
    const serviceId = idDe(i.servicio);
    const quantity = i.quantity.toFixed(3);
    const actualizadas = await db
      .update(serviceProduct)
      .set({ quantity, updatedAt: new Date() })
      .where(and(eq(serviceProduct.serviceId, serviceId), eq(serviceProduct.productId, i.productId)))
      .returning({ id: serviceProduct.id });
    if (actualizadas.length === 0) await db.insert(serviceProduct).values({ serviceId, productId: i.productId, quantity });
  }

  // Categorías web: sólo altas.
  for (const c of plan.categorias) {
    const serviceId = idDe(c.servicio);
    const ya = await db
      .select({ id: serviceCategory.serviceId })
      .from(serviceCategory)
      .where(and(eq(serviceCategory.serviceId, serviceId), eq(serviceCategory.categoryId, c.categoryId)))
      .limit(1);
    if (ya.length === 0) await db.insert(serviceCategory).values({ serviceId, categoryId: c.categoryId });
  }

  // Historial de precios: una cabecera + un ítem por servicio, igual que el ajuste en bloque.
  if (items.length > 0) {
    const [cab] = await db
      .insert(priceAdjustments)
      .values({
        userId: usuario.id,
        userEmail: usuario.email,
        categoryId: areaId,
        mode: "planilla",
        servicesCount: items.length,
      })
      .returning({ id: priceAdjustments.id });
    if (!cab) throw new Error("No se pudo guardar el historial");
    await db.insert(priceAdjustmentItems).values(
      items.map((it) => ({
        adjustmentId: cab.id,
        serviceId: it.serviceId,
        listBefore: money(it.listBefore),
        listAfter: money(it.listAfter),
        cashBefore: money(it.cashBefore),
        cashAfter: money(it.cashAfter),
      })),
    );
  }
}

export async function aplicarPlanilla(
  db: Db,
  e: EntradaPlanilla,
  usuario: { id: string | null; email: string | null },
): Promise<Previsualizacion["resumen"]> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const area = await buscarArea(txDb, e.area);

    // Los servicios del área quedan bloqueados: lo que se compara es lo que se escribe.
    await tx.execute(sql`
      SELECT s.id FROM service s
      JOIN service_category sc ON sc.service_id = s.id
      WHERE sc.category_id = ${area.id}
        AND s.is_active = true
        AND COALESCE(s.no_vendible, false) = false
      FOR UPDATE OF s
    `);

    const [actual, catalogo] = await Promise.all([leerContenido(txDb, area.id), cargarCatalogo(txDb, area.id)]);
    const { plan, vista } = planificarPlanilla({ original: e.original, editada: e.editada, actual, catalogo });
    if (vista.errores.length > 0) throw new ErroresDePlanilla(vista.errores);

    await ejecutarPlan(txDb, plan, area.id, catalogo, usuario);
    return vista.resumen;
  });
}
