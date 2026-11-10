// Carga masiva de servicios por planilla — lógica PURA (sin base de datos).
//
// Valida lo que Laura subió, lo compara contra lo que bajó (`original`) y contra
// lo que la base dice HOY (`actual`), y arma el plan de cambios. Quien llama
// (repo/ruta) es el que lee la base y el que aplica el plan: acá no hay I/O.

// ───────────────────────── Contrato compartido (API ↔ front) ─────────────────────────

export type Celda = string | number | null; // Sí/No viajan como texto

export type FilaServicioPlanilla = {
  fila: number; // número de fila de Excel (la primera de datos es 2)
  id: string | null;
  nombre: Celda;
  codigo: Celda;
  descripcion: Celda;
  precioLista: Celda;
  precioEfectivo: Celda;
  duracion: Celda;
  unidad: Celda;
  requiereOperadora: Celda;
  requiereMaquina: Celda;
  maquina: Celda;
  visibleWeb: Celda;
  destacado: Celda;
  ordenWeb: Celda;
  beneficios: Celda;
  contraindicaciones: Celda;
  instrucciones: Celda;
};
export type FilaAcuerdoPlanilla = { fila: number; servicio: Celda; proveedora: Celda; tipoDePago: Celda; tarifa: Celda };
export type FilaInsumoPlanilla = { fila: number; servicio: Celda; insumo: Celda; cantidad: Celda };
export type FilaCategoriaPlanilla = { fila: number; servicio: Celda; categoria: Celda };

export type ContenidoPlanilla = {
  servicios: FilaServicioPlanilla[];
  acuerdos: FilaAcuerdoPlanilla[];
  insumos: FilaInsumoPlanilla[];
  categorias: FilaCategoriaPlanilla[];
};

export type ListasPlanilla = {
  maquinas: string[];
  proveedoras: string[];
  insumos: string[];
  categorias: string[]; // rutas "Madre › Hija › Nieta"
  tiposDePago: string[]; // ["Por hora", "Porcentaje (%)", "Fijo por servicio"]
};

export type PlanillaDescarga = {
  area: { id: string; nombre: string };
  generadaEn: string; // ISO
  contenido: ContenidoPlanilla;
  listas: ListasPlanilla;
};

export type EntradaPlanilla = { area: string; original: ContenidoPlanilla; editada: ContenidoPlanilla };

export type Pestana = "Servicios" | "Proveedoras" | "Insumos" | "Categorías web" | "Archivo";
export type ErrorDePlanilla = { pestana: Pestana; fila: number | null; mensaje: string };
export type Cambio = { campo: string; antes: string; despues: string }; // `campo` = encabezado de la columna

export type Previsualizacion = {
  errores: ErrorDePlanilla[];
  servicios: { fila: number; id: string | null; nombre: string; tipo: "nuevo" | "modificado"; cambios: Cambio[] }[];
  acuerdos: { fila: number; servicio: string; proveedora: string; tipo: "nuevo" | "cambia"; antes: string | null; despues: string }[];
  insumos: { fila: number; servicio: string; insumo: string; tipo: "nuevo" | "cambia"; antes: number | null; despues: number }[];
  categorias: { fila: number; servicio: string; categoria: string }[];
  combosAfectados: { id: string; nombre: string; kind: "combo" | "pack" }[];
  resumen: { serviciosNuevos: number; serviciosModificados: number; acuerdos: number; insumos: number; categorias: number };
};

// ───────────────────────── Encabezados y mapeos ─────────────────────────

export type ServicioNormalizado = {
  name: string | null;
  code: string | null;
  description: string | null;
  unitPriceList: number | null;
  unitPriceCash: number | null;
  estimatedDurationMinutes: number | null;
  unitType: string | null;
  requiresOperator: boolean | null;
  requiresMachine: boolean | null;
  maquina: string | null;
  isVisible: boolean | null;
  isFeatured: boolean | null;
  webSortOrder: number | null;
  benefits: string | null;
  contraindications: string | null;
  specialAttentionNotes: string | null;
};

export const ENCABEZADO_ID = "id (no tocar)";

export const ENCABEZADOS_SERVICIOS: Record<keyof ServicioNormalizado, string> = {
  name: "Nombre",
  code: "Código",
  description: "Descripción",
  unitPriceList: "Precio lista",
  unitPriceCash: "Precio efectivo",
  estimatedDurationMinutes: "Duración (min)",
  unitType: "Unidad",
  requiresOperator: "Requiere operadora",
  requiresMachine: "Requiere máquina",
  maquina: "Máquina",
  isVisible: "Visible en la web",
  isFeatured: "Destacado en el home",
  webSortOrder: "Orden web (destacados)",
  benefits: "Beneficios",
  contraindications: "Contraindicaciones",
  specialAttentionNotes: "Instrucciones especiales",
};

export const ENCABEZADOS_PROVEEDORAS = ["Servicio", "Proveedora", "Tipo de pago", "Tarifa"] as const;
export const ENCABEZADOS_INSUMOS = ["Servicio", "Insumo", "Cantidad"] as const;
export const ENCABEZADOS_CATEGORIAS = ["Servicio", "Categoría web"] as const;

export const TIPO_DE_PAGO_A_CODIGO: Record<string, string> = {
  "Por hora": "per_hour",
  "Porcentaje (%)": "percentage",
  "Fijo por servicio": "fixed_per_service",
};
export const CODIGO_A_TIPO_DE_PAGO: Record<string, string> = {
  per_hour: "Por hora",
  percentage: "Porcentaje (%)",
  fixed_per_service: "Fijo por servicio",
};
export const TIPOS_DE_PAGO = Object.keys(TIPO_DE_PAGO_A_CODIGO);

export const CAMPOS_OBLIGATORIOS_AL_VACIAR: (keyof ServicioNormalizado)[] = [
  "unitPriceList",
  "unitPriceCash",
  "estimatedDurationMinutes",
  "requiresOperator",
  "requiresMachine",
  "isVisible",
  "isFeatured",
];
export const OBLIGATORIOS_EN_NUEVO: (keyof ServicioNormalizado)[] = [
  "name",
  "unitPriceList",
  "unitPriceCash",
  "estimatedDurationMinutes",
];

/** Campo normalizado → campo de la fila de la planilla. */
export const CAMPO_DE_FILA: Record<keyof ServicioNormalizado, keyof FilaServicioPlanilla> = {
  name: "nombre",
  code: "codigo",
  description: "descripcion",
  unitPriceList: "precioLista",
  unitPriceCash: "precioEfectivo",
  estimatedDurationMinutes: "duracion",
  unitType: "unidad",
  requiresOperator: "requiereOperadora",
  requiresMachine: "requiereMaquina",
  maquina: "maquina",
  isVisible: "visibleWeb",
  isFeatured: "destacado",
  webSortOrder: "ordenWeb",
  benefits: "beneficios",
  contraindications: "contraindicaciones",
  specialAttentionNotes: "instrucciones",
};

const CLAVES = Object.keys(ENCABEZADOS_SERVICIOS) as (keyof ServicioNormalizado)[];

// ───────────────────────── Celdas ─────────────────────────

const REGEX_NUMERO = /^-?\d+(?:[.,]\d+)?$/;
// Miles argentinos: "1.500", "45.000", "1.500,50". Un texto así se lee SIEMPRE como miles
// (nunca como 1,5), porque en esta planilla el punto no se usa de decimal con 3 dígitos.
const REGEX_MILES = /^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/;

/** Número de un texto (o NaN). Las celdas de tipo número no pasan por acá. */
function textoANumero(t: string): number {
  if (REGEX_MILES.test(t)) return Number(t.replace(/\./g, "").replace(",", "."));
  if (REGEX_NUMERO.test(t)) return Number(t.replace(",", "."));
  return Number.NaN;
}

function sinTildes(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Forma canónica de una celda para compararla: Excel/Sheets reformatean. */
function canonica(c: Celda | undefined): string | number | null {
  if (c === null || c === undefined) return null;
  if (typeof c === "number") return Number.isFinite(c) ? c : null;
  const t = c.trim();
  if (t === "") return null;
  const n = textoANumero(t);
  if (Number.isFinite(n)) return n;
  const sb = sinTildes(t).toLowerCase();
  if (sb === "si") return "sí";
  if (sb === "no") return "no";
  return t;
}

export function celdasIguales(a: Celda | undefined, b: Celda | undefined): boolean {
  return canonica(a) === canonica(b);
}

function vacia(c: Celda | undefined): boolean {
  return canonica(c) === null;
}

function mostrar(c: Celda | undefined): string {
  const t = c === null || c === undefined ? "" : String(c).trim();
  return t === "" ? "(vacío)" : t;
}

// ───────────────────────── Normalizar un servicio ─────────────────────────

type Tipo = { tipo: "texto"; max: number } | { tipo: "plata" } | { tipo: "entero" } | { tipo: "sino" };

const TIPOS: Record<keyof ServicioNormalizado, Tipo> = {
  name: { tipo: "texto", max: 255 },
  code: { tipo: "texto", max: 50 },
  description: { tipo: "texto", max: 2000 },
  unitPriceList: { tipo: "plata" },
  unitPriceCash: { tipo: "plata" },
  estimatedDurationMinutes: { tipo: "entero" },
  unitType: { tipo: "texto", max: 50 },
  requiresOperator: { tipo: "sino" },
  requiresMachine: { tipo: "sino" },
  maquina: { tipo: "texto", max: 255 },
  isVisible: { tipo: "sino" },
  isFeatured: { tipo: "sino" },
  webSortOrder: { tipo: "entero" },
  benefits: { tipo: "texto", max: 2000 },
  contraindications: { tipo: "texto", max: 2000 },
  specialAttentionNotes: { tipo: "texto", max: 2000 },
};

function aNumero(c: Celda | undefined): number {
  if (typeof c === "number") return c;
  const t = (c ?? "").trim();
  return textoANumero(t);
}

function mostrarNumero(c: Celda | undefined): string {
  const x = canonica(c);
  return typeof x === "number" ? String(x) : mostrar(c);
}

/** Cómo se muestra una celda de un campo: los numéricos, como el número que se va a guardar. */
function mostrarCampo(k: keyof ServicioNormalizado, c: Celda | undefined): string {
  const tipo = TIPOS[k].tipo;
  if (tipo === "plata" || tipo === "entero") {
    const x = canonica(c);
    if (typeof x === "number") return String(x);
  }
  return mostrar(c);
}

/** Valida y tipa UNA celda. Celda vacía → `null` sin error (la obligatoriedad se decide afuera). */
function normalizarCampo(
  clave: keyof ServicioNormalizado,
  celda: Celda,
): { valor: string | number | boolean | null; error?: string } {
  const enc = ENCABEZADOS_SERVICIOS[clave];
  if (vacia(celda)) return { valor: null };
  const t = TIPOS[clave];
  switch (t.tipo) {
    case "texto": {
      const s = String(celda).trim();
      if (s.length > t.max) {
        return { valor: null, error: `${enc} es demasiado largo: tiene ${s.length} caracteres y el máximo es ${t.max}.` };
      }
      return { valor: s };
    }
    case "plata": {
      const n = aNumero(celda);
      if (!Number.isFinite(n)) return { valor: null, error: `${enc} tiene que ser un número (por ejemplo 45000).` };
      if (n < 0) return { valor: null, error: `${enc} no puede ser negativo.` };
      return { valor: n };
    }
    case "entero": {
      const n = aNumero(celda);
      if (!Number.isFinite(n)) return { valor: null, error: `${enc} tiene que ser un número entero.` };
      if (!Number.isInteger(n)) return { valor: null, error: `${enc} tiene que ser un número entero, sin decimales.` };
      if (n < 0) return { valor: null, error: `${enc} no puede ser negativo.` };
      return { valor: n };
    }
    case "sino": {
      const c = canonica(celda);
      if (c === "sí") return { valor: true };
      if (c === "no") return { valor: false };
      return { valor: null, error: `${enc} tiene que ser Sí o No.` };
    }
  }
}

export function normalizarServicio(f: FilaServicioPlanilla): { valor: ServicioNormalizado; errores: ErrorDePlanilla[] } {
  const valor = {} as Record<string, string | number | boolean | null>;
  const errores: ErrorDePlanilla[] = [];
  for (const k of CLAVES) {
    const r = normalizarCampo(k, f[CAMPO_DE_FILA[k]] as Celda);
    valor[k] = r.valor;
    if (r.error) errores.push({ pestana: "Servicios", fila: f.fila, mensaje: r.error });
  }
  return { valor: valor as unknown as ServicioNormalizado, errores };
}

// ───────────────────────── Planificar ─────────────────────────

export type Catalogo = {
  maquinas: Map<string, string | null>;
  proveedoras: Map<string, string | null>;
  insumos: Map<string, string | null>;
  categorias: Map<string, string | null>;
  idsDelArea: Set<string>;
};

type Ref = { id: string } | { nuevaFila: number };

export type PlanDePlanilla = {
  crear: { fila: number; datos: ServicioNormalizado }[];
  actualizar: {
    id: string;
    fila: number;
    patch: Partial<ServicioNormalizado>;
    precioAntes: { lista: number | null; efectivo: number | null } | null;
  }[];
  acuerdos: { servicio: Ref; proveedoraId: string; paymentType: string; rate: number; cerrarVigente: boolean }[];
  insumos: { servicio: Ref; productId: string; quantity: number }[];
  categorias: { servicio: Ref; categoryId: string }[];
};

type Vista = Omit<Previsualizacion, "combosAfectados">;

const clave = (c: Celda | undefined): string => String(canonica(c) ?? "").toLowerCase();

/** Busca un nombre en el catálogo: exacto, y si no, sin mayúsculas. `undefined` = no existe, `null` = ambiguo. */
export function buscar(mapa: Map<string, string | null>, nombre: Celda): string | null | undefined {
  const n = String(nombre ?? "").trim();
  if (mapa.has(n)) return mapa.get(n) as string | null;
  const bajo = n.toLowerCase();
  const ids = new Set<string | null>();
  for (const [k, v] of mapa) if (k.trim().toLowerCase() === bajo) ids.add(v);
  if (ids.size === 0) return undefined;
  return ids.size === 1 ? [...ids][0] : null;
}

type FilaRel = { fila: number; servicio: Celda; rel: Celda; celdas: Celda[] };

type ResultadoRel<V> = {
  tipo: "alta" | "cambio";
  ref: Ref;
  fila: number;
  servicio: string;
  rel: string;
  valor: V;
  antes: Celda[] | null;
};

type ConfigRel<V> = {
  pestana: Pestana;
  /** Nombre de la cosa para los mensajes de conflicto ("La tarifa", "La cantidad"). */
  etiqueta: string;
  filas: (c: ContenidoPlanilla) => FilaRel[];
  /** Valida y resuelve la fila (catálogo incluido). Sólo se llama si la fila va a escribir algo. */
  validar: (f: FilaRel) => { valor?: V; error?: string };
  describir: (celdas: Celda[]) => string;
};

function planificarRelacion<V>(
  cfg: ConfigRel<V>,
  p: { original: ContenidoPlanilla; editada: ContenidoPlanilla; actual: ContenidoPlanilla },
  serviciosEditados: Map<string, { fila: number; id: string | null; nombre: string }>,
  errores: ErrorDePlanilla[],
): ResultadoRel<V>[] {
  const err = (fila: number | null, mensaje: string) => errores.push({ pestana: cfg.pestana, fila, mensaje });

  // Pares (id del servicio, relación) de lo bajado y de lo de hoy.
  const indexar = (c: ContenidoPlanilla) => {
    const idPorNombre = new Map<string, string>();
    for (const s of c.servicios) if (s.id && !vacia(s.nombre)) idPorNombre.set(clave(s.nombre), s.id);
    const m = new Map<string, FilaRel>();
    for (const f of cfg.filas(c)) {
      const id = idPorNombre.get(clave(f.servicio));
      if (id) m.set(`${id}|${clave(f.rel)}`, f);
    }
    return m;
  };
  const enOriginal = indexar(p.original);
  const enActual = indexar(p.actual);

  // Servicios que Laura sacó de la pestaña Servicios (por id): borrar una fila no borra nada.
  const idsEditados = new Set(p.editada.servicios.map((s) => s.id).filter((i): i is string => !!i && i.trim() !== ""));
  const idPorNombreOriginal = new Map<string, string>();
  for (const s of p.original.servicios) if (s.id && !vacia(s.nombre)) idPorNombreOriginal.set(clave(s.nombre), s.id);
  const filasOriginal = cfg.filas(p.original);
  /** La fila es idéntica a una de `original` y su servicio ya no está en la planilla editada. */
  const sacadaConElServicio = (f: FilaRel): boolean => {
    const id = idPorNombreOriginal.get(clave(f.servicio));
    if (!id || idsEditados.has(id)) return false; // si el id sigue, fue un renombre: error
    return filasOriginal.some(
      (o) =>
        clave(o.servicio) === clave(f.servicio) &&
        clave(o.rel) === clave(f.rel) &&
        o.celdas.length === f.celdas.length &&
        o.celdas.every((c, i) => celdasIguales(c, f.celdas[i])),
    );
  };

  const salida: ResultadoRel<V>[] = [];
  const vistos = new Set<string>();

  for (const f of cfg.filas(p.editada)) {
    if (vacia(f.servicio) && vacia(f.rel) && f.celdas.every(vacia)) continue; // fila en blanco
    if (vacia(f.servicio)) {
      err(f.fila, "Falta el servicio: elegilo de la lista.");
      continue;
    }
    const srv = serviciosEditados.get(clave(f.servicio));
    if (!srv && sacadaConElServicio(f)) continue; // sacó el servicio de la planilla: sus relaciones quedan como están
    if (!srv) {
      err(f.fila, `No existe el servicio «${String(f.servicio).trim()}» en la pestaña Servicios. Si le cambiaste el nombre, usá el nombre nuevo.`);
      continue;
    }
    if (vacia(f.rel)) {
      err(f.fila, `Falta completar la columna ${cfg.pestana === "Proveedoras" ? "Proveedora" : cfg.pestana === "Insumos" ? "Insumo" : "Categoría web"}.`);
      continue;
    }
    const ref: Ref = srv.id ? { id: srv.id } : { nuevaFila: srv.fila };
    const kPar = `${srv.id ?? `nueva:${srv.fila}`}|${clave(f.rel)}`;
    if (vistos.has(kPar)) {
      err(f.fila, `«${String(f.rel).trim()}» está repetido para el servicio «${srv.nombre}»: cada uno va una sola vez.`);
      continue;
    }
    vistos.add(kPar);

    const o = srv.id ? enOriginal.get(kPar) : undefined;
    const a = srv.id ? enActual.get(kPar) : undefined;
    const iguales = (x: FilaRel, y: FilaRel) => x.celdas.every((c, i) => clave(c) === clave(y.celdas[i]));

    let tipo: "alta" | "cambio";
    if (!o) {
      if (a) {
        if (iguales(f, a)) continue; // ya estaba en el sistema igual
        err(
          f.fila,
          `${cfg.etiqueta} de «${String(f.rel).trim()}» en «${srv.nombre}» se cargó en el sistema después de que bajaste la planilla: ahora es ${cfg.describir(a.celdas)}, en la planilla pusiste ${cfg.describir(f.celdas)}. Bajá una planilla nueva.`,
        );
        continue;
      }
      tipo = "alta";
    } else {
      if (iguales(f, o)) continue; // no la tocó
      if (!a || !iguales(a, o)) {
        err(
          f.fila,
          `${cfg.etiqueta} de «${String(f.rel).trim()}» en «${srv.nombre}» cambió en el sistema después de que bajaste la planilla: ahora es ${a ? cfg.describir(a.celdas) : "(sin cargar)"}, en la planilla pusiste ${cfg.describir(f.celdas)}. Bajá una planilla nueva.`,
        );
        continue;
      }
      tipo = "cambio";
    }

    const v = cfg.validar(f);
    if (v.error || v.valor === undefined) {
      err(f.fila, v.error ?? "Fila inválida.");
      continue;
    }
    salida.push({
      tipo,
      ref,
      fila: f.fila,
      servicio: srv.nombre,
      rel: String(f.rel).trim(),
      valor: v.valor,
      antes: o ? o.celdas : null,
    });
  }
  return salida;
}

export function planificarPlanilla(p: {
  original: ContenidoPlanilla;
  editada: ContenidoPlanilla;
  actual: ContenidoPlanilla;
  catalogo: Catalogo;
}): { plan: PlanDePlanilla; vista: Vista } {
  const { original, editada, actual, catalogo } = p;
  const errores: ErrorDePlanilla[] = [];
  const plan: PlanDePlanilla = { crear: [], actualizar: [], acuerdos: [], insumos: [], categorias: [] };
  const vista: Vista = {
    errores,
    servicios: [],
    acuerdos: [],
    insumos: [],
    categorias: [],
    resumen: { serviciosNuevos: 0, serviciosModificados: 0, acuerdos: 0, insumos: 0, categorias: 0 },
  };
  const errS = (fila: number | null, mensaje: string) => errores.push({ pestana: "Servicios", fila, mensaje });

  const originalPorId = new Map(original.servicios.filter((s) => s.id).map((s) => [s.id as string, s]));
  const actualPorId = new Map(actual.servicios.filter((s) => s.id).map((s) => [s.id as string, s]));
  const serviciosEditados = new Map<string, { fila: number; id: string | null; nombre: string }>();
  const idsVistos = new Set<string>();

  // ── Servicios ──
  for (const f of editada.servicios) {
    const sinId = f.id === null || f.id.trim() === "";
    const hayNombre = !vacia(f.nombre);
    if (sinId && CLAVES.every((k) => vacia(f[CAMPO_DE_FILA[k]] as Celda))) continue; // fila en blanco

    // Nombre repetido (cuenta para el mapa de relaciones también).
    if (hayNombre) {
      const k = clave(f.nombre);
      if (serviciosEditados.has(k)) {
        errS(f.fila, `El nombre «${String(f.nombre).trim()}» está repetido en la pestaña Servicios (también en la fila ${serviciosEditados.get(k)!.fila}). Cada servicio tiene que tener un nombre distinto.`);
      } else {
        serviciosEditados.set(k, { fila: f.fila, id: sinId ? null : (f.id as string), nombre: String(f.nombre).trim() });
      }
    }

    if (sinId) {
      planificarNuevo(f);
    } else {
      const id = f.id as string;
      if (idsVistos.has(id)) {
        errS(f.fila, "Esta fila repite el id de otra fila. No toques la columna id.");
        continue;
      }
      idsVistos.add(id);
      planificarExistente(f, id);
    }
  }

  function validarMaquina(f: FilaServicioPlanilla, valor: ServicioNormalizado) {
    if (valor.maquina === null) return;
    const id = buscar(catalogo.maquinas, valor.maquina);
    if (id === undefined) errS(f.fila, `La máquina «${valor.maquina}» no existe. Elegila de la lista.`);
    else if (id === null) errS(f.fila, `Hay más de una máquina llamada «${valor.maquina}»: no se sabe cuál es.`);
  }

  function planificarNuevo(f: FilaServicioPlanilla) {
    const { valor, errores: es } = normalizarServicio(f);
    errores.push(...es);
    for (const k of OBLIGATORIOS_EN_NUEVO) {
      if (valor[k] === null && !es.some((e) => e.mensaje.startsWith(ENCABEZADOS_SERVICIOS[k]))) {
        errS(f.fila, `${ENCABEZADOS_SERVICIOS[k]} es obligatorio en un servicio nuevo.`);
      }
    }
    // Los Sí/No vacíos toman el default del modal.
    valor.requiresOperator ??= false;
    valor.requiresMachine ??= false;
    valor.isVisible ??= true;
    valor.isFeatured ??= false;
    validarMaquina(f, valor);
    const tieneCategoria = editada.categorias.some((c) => !vacia(c.servicio) && !vacia(f.nombre) && clave(c.servicio) === clave(f.nombre) && !vacia(c.categoria));
    if (!tieneCategoria) {
      errS(f.fila, "Un servicio nuevo necesita al menos una categoría web: cargala en la pestaña Categorías web.");
    }
    plan.crear.push({ fila: f.fila, datos: valor });
    vista.servicios.push({ fila: f.fila, id: null, nombre: valor.name ?? "", tipo: "nuevo", cambios: [] });
    vista.resumen.serviciosNuevos++;
  }

  function planificarExistente(f: FilaServicioPlanilla, id: string) {
    const o = originalPorId.get(id);
    if (!o || !catalogo.idsDelArea.has(id)) {
      errS(f.fila, "Esta fila tiene un id que no es de esta área. No toques la columna id.");
      return;
    }
    const a = actualPorId.get(id);
    const nombreRef = mostrar(o.nombre);
    const patch: Record<string, string | number | boolean | null> = {};
    const cambios: Cambio[] = [];
    let hayError = false;

    for (const k of CLAVES) {
      const campoFila = CAMPO_DE_FILA[k];
      const cEd = f[campoFila] as Celda;
      const cOr = o[campoFila] as Celda;
      if (celdasIguales(cOr, cEd)) continue; // no la tocó
      const enc = ENCABEZADOS_SERVICIOS[k];

      if (a && !celdasIguales(cOr, a[campoFila] as Celda)) {
        errS(
          f.fila,
          `${enc} de «${nombreRef}» cambió en el sistema después de que bajaste la planilla: ahora es ${mostrarCampo(k, a[campoFila] as Celda)}, en la planilla pusiste ${mostrarCampo(k, cEd)}. Bajá una planilla nueva.`,
        );
        hayError = true;
        continue;
      }
      const r = normalizarCampo(k, cEd);
      if (r.error) {
        errS(f.fila, r.error);
        hayError = true;
        continue;
      }
      if (r.valor === null && (k === "name" || CAMPOS_OBLIGATORIOS_AL_VACIAR.includes(k))) {
        errS(f.fila, `${enc} de «${nombreRef}» no se puede dejar vacío.`);
        hayError = true;
        continue;
      }
      patch[k] = r.valor;
      cambios.push({ campo: enc, antes: mostrarCampo(k, cOr), despues: mostrarCampo(k, cEd) });
    }

    if (patch.maquina != null) {
      validarMaquina(f, { maquina: patch.maquina as string } as ServicioNormalizado);
    }
    if (hayError || cambios.length === 0) return;

    let precioAntes: { lista: number | null; efectivo: number | null } | null = null;
    if ("unitPriceList" in patch || "unitPriceCash" in patch) {
      const fuente = a ?? o;
      const n = (c: Celda) => {
        const x = canonica(c);
        return typeof x === "number" ? x : null;
      };
      precioAntes = { lista: n(fuente.precioLista), efectivo: n(fuente.precioEfectivo) };
    }
    plan.actualizar.push({ id, fila: f.fila, patch: patch as Partial<ServicioNormalizado>, precioAntes });
    vista.servicios.push({ fila: f.fila, id, nombre: mostrar(f.nombre), tipo: "modificado", cambios });
    vista.resumen.serviciosModificados++;
  }

  const ctx = { original, editada, actual };

  // ── Acuerdos ──
  const acuerdos = planificarRelacion(
    {
      pestana: "Proveedoras",
      etiqueta: "El acuerdo",
      filas: (c) => c.acuerdos.map((r) => ({ fila: r.fila, servicio: r.servicio, rel: r.proveedora, celdas: [r.tipoDePago, r.tarifa] })),
      describir: ([tipo, tarifa]) => `${mostrar(tipo)}, ${mostrarNumero(tarifa)}`,
      validar: (f) => {
        const prov = buscar(catalogo.proveedoras, f.rel);
        if (prov === undefined) return { error: `La proveedora «${String(f.rel).trim()}» no existe. Elegila de la lista.` };
        if (prov === null) return { error: `Hay más de una proveedora llamada «${String(f.rel).trim()}»: no se sabe cuál es.` };
        const [tipo, tarifa] = f.celdas;
        const codigo = vacia(tipo)
          ? undefined
          : Object.entries(TIPO_DE_PAGO_A_CODIGO).find(([l]) => clave(l) === clave(tipo))?.[1];
        if (vacia(tipo) || vacia(tarifa)) {
          return {
            error:
              "Cada proveedora necesita cómo cobra y cuánto cobra: un acuerdo sin forma de cobrar no se puede guardar. Si todavía no lo acordaron, sacala de la lista y agregala cuando lo tengan.",
          };
        }
        if (!codigo) return { error: `El tipo de pago «${String(tipo).trim()}» no es válido. Elegí uno de la lista: ${TIPOS_DE_PAGO.join(", ")}.` };
        const rate = aNumero(tarifa);
        if (!Number.isFinite(rate)) return { error: "La tarifa tiene que ser un número." };
        if (rate === 0) {
          return { error: "La tarifa no puede ser 0: una proveedora habilitada con tarifa en cero cobra $0 por cada turno. Poné cuánto cobra de verdad." };
        }
        if (rate < 0) return { error: "La tarifa no puede ser negativa." };
        return { valor: { proveedoraId: prov, paymentType: codigo, rate } };
      },
    },
    ctx,
    serviciosEditados,
    errores,
  );
  for (const r of acuerdos) {
    plan.acuerdos.push({ servicio: r.ref, ...r.valor, cerrarVigente: r.tipo === "cambio" });
    const etiqueta = CODIGO_A_TIPO_DE_PAGO[r.valor.paymentType];
    vista.acuerdos.push({
      fila: r.fila,
      servicio: r.servicio,
      proveedora: r.rel,
      tipo: r.tipo === "alta" ? "nuevo" : "cambia",
      antes: r.antes ? `${mostrar(r.antes[0])}, ${mostrarNumero(r.antes[1])}` : null,
      despues: `${etiqueta}, ${r.valor.rate}`,
    });
    vista.resumen.acuerdos++;
  }

  // ── Insumos ──
  const insumos = planificarRelacion(
    {
      pestana: "Insumos",
      etiqueta: "La cantidad",
      filas: (c) => c.insumos.map((r) => ({ fila: r.fila, servicio: r.servicio, rel: r.insumo, celdas: [r.cantidad] })),
      describir: ([cant]) => mostrarNumero(cant),
      validar: (f) => {
        const id = buscar(catalogo.insumos, f.rel);
        if (id === undefined) return { error: `El insumo «${String(f.rel).trim()}» no existe. Elegilo de la lista.` };
        if (id === null) return { error: `Hay más de un insumo llamado «${String(f.rel).trim()}»: no se sabe cuál es.` };
        const q = aNumero(f.celdas[0]);
        if (!Number.isFinite(q)) return { error: "La cantidad tiene que ser un número." };
        if (q <= 0) return { error: "La cantidad tiene que ser mayor que 0." };
        return { valor: { productId: id, quantity: q } };
      },
    },
    ctx,
    serviciosEditados,
    errores,
  );
  for (const r of insumos) {
    plan.insumos.push({ servicio: r.ref, ...r.valor });
    const antes = r.antes ? canonica(r.antes[0]) : null;
    vista.insumos.push({
      fila: r.fila,
      servicio: r.servicio,
      insumo: r.rel,
      tipo: r.tipo === "alta" ? "nuevo" : "cambia",
      antes: typeof antes === "number" ? antes : null,
      despues: r.valor.quantity,
    });
    vista.resumen.insumos++;
  }

  // ── Categorías web (sólo altas) ──
  const categorias = planificarRelacion(
    {
      pestana: "Categorías web",
      etiqueta: "La categoría",
      filas: (c) => c.categorias.map((r) => ({ fila: r.fila, servicio: r.servicio, rel: r.categoria, celdas: [] })),
      describir: () => "",
      validar: (f) => {
        const id = buscar(catalogo.categorias, f.rel);
        if (id === undefined) return { error: `La categoría «${String(f.rel).trim()}» no existe. Elegila de la lista.` };
        if (id === null) return { error: `Hay más de una categoría con la ruta «${String(f.rel).trim()}»: no se sabe cuál es.` };
        return { valor: { categoryId: id } };
      },
    },
    ctx,
    serviciosEditados,
    errores,
  );
  for (const r of categorias) {
    plan.categorias.push({ servicio: r.ref, ...r.valor });
    vista.categorias.push({ fila: r.fila, servicio: r.servicio, categoria: r.rel });
    vista.resumen.categorias++;
  }

  return { plan, vista };
}
