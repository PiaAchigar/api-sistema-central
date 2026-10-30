import { z } from "zod";

// Cálculo puro del ajuste de precios en bloque. No toca la base:
// la ruta que lo usa le pasa los precios actuales y guarda lo que devuelve.

export type Redondeo = 1 | 100 | 500 | 1000;

export type Ajuste = {
  direccion: "subir" | "bajar";
  modo: "porcentaje" | "monto";
  valor: number;
  redondeo: Redondeo;
};

export type EstadoFila = "cambia" | "no_cambia" | "sin_precio" | "invalido";

// Redondea al múltiplo más cercano (redondeo 1 = pesos enteros).
export function precioNuevo(actual: number, ajuste: Ajuste): number {
  const signo = ajuste.direccion === "subir" ? 1 : -1;
  const bruto =
    ajuste.modo === "porcentaje"
      ? actual * (1 + (signo * ajuste.valor) / 100)
      : actual + signo * ajuste.valor;
  return Math.round(bruto / ajuste.redondeo) * ajuste.redondeo;
}

// Una fila sin lista no tiene precio que ajustar: el efectivo tampoco se toca.
// Un precio que queda en 0 o menos no se puede guardar: la fila es inválida.
export function calcularFila(
  listaActual: number | null,
  efectivoActual: number | null,
  ajuste: Ajuste,
): { listaDespues: number | null; efectivoDespues: number | null; estado: EstadoFila } {
  if (listaActual === null || listaActual <= 0) {
    return { listaDespues: null, efectivoDespues: null, estado: "sin_precio" };
  }

  const listaDespues = precioNuevo(listaActual, ajuste);
  const efectivoDespues =
    efectivoActual === null || efectivoActual <= 0 ? null : precioNuevo(efectivoActual, ajuste);

  if (listaDespues <= 0 || (efectivoDespues !== null && efectivoDespues <= 0)) {
    return { listaDespues, efectivoDespues, estado: "invalido" };
  }

  const sinCambio = listaDespues === listaActual && efectivoDespues === efectivoActual;
  return { listaDespues, efectivoDespues, estado: sinCambio ? "no_cambia" : "cambia" };
}

// Límites del formulario: lo que no tenga sentido se rechaza antes del cálculo.
export const ajusteSchema: z.ZodType<Ajuste> = z
  .object({
    direccion: z.enum(["subir", "bajar"]),
    modo: z.enum(["porcentaje", "monto"]),
    valor: z.number().positive(),
    redondeo: z.union([z.literal(1), z.literal(100), z.literal(500), z.literal(1000)]),
  })
  .superRefine((a, ctx) => {
    if (a.modo === "monto" && !Number.isInteger(a.valor)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["valor"], message: "El monto debe ser entero" });
    }
    if (a.direccion === "bajar" && a.modo === "porcentaje" && a.valor >= 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["valor"], message: "Bajar un porcentaje debe ser menor a 100" });
    }
  });
