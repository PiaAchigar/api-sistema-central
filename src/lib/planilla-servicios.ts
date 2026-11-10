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

function sinTildes(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Forma canónica de una celda para compararla: Excel/Sheets reformatean. */
function canonica(c: Celda | undefined): string | number | null {
  if (c === null || c === undefined) return null;
  if (typeof c === "number") return Number.isFinite(c) ? c : null;
  const t = c.trim();
  if (t === "") return null;
  if (REGEX_NUMERO.test(t)) return Number(t.replace(",", "."));
  const sb = sinTildes(t).toLowerCase();
  if (sb === "si") return "sí";
  if (sb === "no") return "no";
  return t;
}

export function celdasIguales(a: Celda, b: Celda): boolean {
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

function aNumero(c: Celda): number {
  if (typeof c === "number") return c;
  const t = (c ?? "").trim();
  return REGEX_NUMERO.test(t) ? Number(t.replace(",", ".")) : Number.NaN;
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

