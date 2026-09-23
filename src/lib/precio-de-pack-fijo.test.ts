import { describe, expect, it } from "vitest";
import type { DepilationConfig, ZonaParaCotizar } from "./depilation-pricing";
import { precioDePackFijo } from "./precio-de-pack-fijo";

const CONFIG: DepilationConfig = {
  precioLista: {
    mujer:  { grande: 19000, mediana: 17000, chica: 12000 },
    hombre: { grande: 23000, mediana: 22000, chica: 19000 },
  },
  minutosPrecio: {
    mujer:  { grande: 10, mediana: 7, chica: 5 },
    hombre: { grande: 11, mediana: 9, chica: 8 },
  },
  tarifaEscalon1: 1200,
  tarifaEscalon2: 1000,
  minutosTurno: {
    mujer:  { grande: 9,  mediana: 6, chica: 3 },
    hombre: { grande: 10, mediana: 8, chica: 5 },
  },
  redondeoTurno: 5,
  turnoMinimo: 10,
  packSesiones: 3,
  packDescuentoPct: 15,
  packRedondeo: 1000,
};

const zona = (id: string, categoria: ZonaParaCotizar["categoria"]): ZonaParaCotizar => ({
  id, nombre: id, categoria,
});

/** "Cuerpo Full" de producción: 5 grandes + 5 chicas, sin zona a elección. */
const CUERPO_FULL = [
  ...Array.from({ length: 5 }, (_, i) => zona(`g${i}`, "grande")),
  ...Array.from({ length: 5 }, (_, i) => zona(`c${i}`, "chica")),
];

/** "Combo de Esenciales": 2 grandes + 3 chicas + 1 a elección. */
const ESENCIALES = [
  zona("pierna", "grande"), zona("rostro", "grande"),
  zona("axila", "chica"), zona("cavado", "chica"), zona("tira", "chica"),
];

describe("precioDePackFijo", () => {
  it("a una mujer le cobra el precio cargado, tal cual", () => {
    expect(precioDePackFijo(65000, CUERPO_FULL, 0, null, "mujer", CONFIG)).toBe(65000);
  });

  /**
   * Cuerpo Full: 60 min a una mujer, 75 a un hombre. 65.000 × 75/60 = 81.250,
   * redondeado con `packRedondeo` (1000) = 81.000. Laura carga UN número y el
   * sistema saca los dos, así que no hay dos packs que se desincronicen.
   */
  it("a un hombre le cobra proporcional al tiempo que su sesión realmente ocupa", () => {
    expect(precioDePackFijo(65000, CUERPO_FULL, 0, null, "hombre", CONFIG)).toBe(81000);
  });

  /**
   * La zona a elección es un REGALO: no suma precio (§10-A). Pero sí suma
   * tiempo, y por lo tanto entra en la proporción del hombre. Esenciales:
   * mujer 2×9 + 4×3 = 30; hombre 2×10 + 4×5 = 40. 49.000 × 40/30 = 65.333 →
   * 65.000.
   */
  it("la zona a elección cuenta para la proporción, porque ocupa agenda", () => {
    expect(precioDePackFijo(49000, ESENCIALES, 1, null, "mujer", CONFIG)).toBe(49000);
    expect(precioDePackFijo(49000, ESENCIALES, 1, null, "hombre", CONFIG)).toBe(65000);
  });

  /**
   * Review Focus #1. Un pack con `fixed_duration_minutes` cargado dura lo
   * mismo para los dos, así que no hay proporción de la que derivar nada.
   * Cobrarle más al hombre sería inventar plata; un NaN sería peor.
   */
  it("con duración fija cargada, el hombre paga lo mismo que la mujer", () => {
    expect(precioDePackFijo(65000, CUERPO_FULL, 0, 90, "hombre", CONFIG)).toBe(65000);
  });

  it("un pack sin zonas no divide por cero: cobra lo cargado", () => {
    expect(precioDePackFijo(50000, [], 0, null, "hombre", CONFIG)).toBe(50000);
  });
});
