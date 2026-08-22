import { describe, expect, it, vi } from "vitest";
import { depilacionRouter, zonaBody, estadoBody, exclusionesBody, configBody } from "./depilacion";
import {
  agruparZonasPorCategoria,
  filasDeExclusion,
  nombreDeZonaEnUso,
  leerConfig,
  guardarExclusiones,
} from "../../repositories/depilacion.repo";
import type { DepilationConfig } from "../../lib/depilation-pricing";

// ── Fixtures: las 24 zonas y las 8 exclusiones (x2 direcciones) reales del
//    seed de la migración 1.35.0, para que el test de agrupación no dependa
//    de datos inventados que puedan desalinearse del catálogo real. ────────
let zid = 0;
const zona = (name: string, category: "grande" | "mediana" | "chica") => ({
  id: `z${++zid}`,
  name,
  category,
  displayOrder: 0,
  isActive: true,
});

const ZONAS_GRANDES = [
  zona("Pierna entera", "grande"),
  zona("Brazos", "grande"),
  zona("Espalda", "grande"),
  zona("Glúteos", "grande"),
  zona("Rostro completo", "grande"),
];
const ZONAS_MEDIANAS = [
  zona("Media pierna", "mediana"),
  zona("Medio brazo", "mediana"),
  zona("Espalda alta", "mediana"),
  zona("Espalda baja", "mediana"),
  zona("Abdomen", "mediana"),
  zona("Pecho", "mediana"),
  zona("Cavado completo", "mediana"),
];
const ZONAS_CHICAS = [
  zona("Axila", "chica"),
  zona("Cavado", "chica"),
  zona("Tira de cola", "chica"),
  zona("Bozo", "chica"),
  zona("Sub mentón / mentón", "chica"),
  zona("Patillas", "chica"),
  zona("Línea alba", "chica"),
  zona("Empeine y dedos de los pies", "chica"),
  zona("Pelvis", "chica"),
  zona("Barba", "chica"),
  zona("Hombros", "chica"),
  zona("Antebrazo", "chica"),
];
const ZONAS = [...ZONAS_GRANDES, ...ZONAS_MEDIANAS, ...ZONAS_CHICAS];
expectLength(ZONAS, 24);
function expectLength(arr: unknown[], n: number) {
  if (arr.length !== n) throw new Error(`fixture mal armado: ${arr.length} zonas, esperaba ${n}`);
}

const porNombre = (name: string) => {
  const z = ZONAS.find((z) => z.name === name);
  if (!z) throw new Error(`fixture: falta la zona "${name}"`);
  return z;
};

// Los 8 pares del PDF §9, cargados en las dos direcciones (16 filas) tal
// como hace la migración 1.35.0.
const PARES: [string, string][] = [
  ["Pierna entera", "Media pierna"],
  ["Brazos", "Medio brazo"],
  ["Espalda", "Espalda baja"],
  ["Espalda", "Espalda alta"],
  ["Cavado completo", "Cavado"],
  ["Rostro completo", "Bozo"],
  ["Rostro completo", "Sub mentón / mentón"],
  ["Rostro completo", "Patillas"],
];
const EXCLUSIONES = PARES.flatMap(([a, b]) => {
  const za = porNombre(a);
  const zb = porNombre(b);
  return [
    { zoneId: za.id, excludesZoneId: zb.id },
    { zoneId: zb.id, excludesZoneId: za.id },
  ];
});

describe("agruparZonasPorCategoria", () => {
  it("agrupa las 24 zonas en grande/mediana/chica", () => {
    const grupos = agruparZonasPorCategoria(ZONAS, EXCLUSIONES);
    expect(grupos.grande).toHaveLength(5);
    expect(grupos.mediana).toHaveLength(7);
    expect(grupos.chica).toHaveLength(12);
  });

  it("adjunta las exclusiones de cada zona", () => {
    const grupos = agruparZonasPorCategoria(ZONAS, EXCLUSIONES);
    const piernaEntera = grupos.grande.find((z) => z.name === "Pierna entera")!;
    const mediaPierna = grupos.mediana.find((z) => z.name === "Media pierna")!;
    expect(piernaEntera.exclusions).toEqual([mediaPierna.id]);
    expect(mediaPierna.exclusions).toEqual([piernaEntera.id]);
  });

  it("una zona con varias exclusiones las trae todas (Rostro completo)", () => {
    const grupos = agruparZonasPorCategoria(ZONAS, EXCLUSIONES);
    const rostro = grupos.grande.find((z) => z.name === "Rostro completo")!;
    const nombresExcluidos = rostro.exclusions
      .map((id) => ZONAS.find((z) => z.id === id)?.name)
      .sort();
    expect(nombresExcluidos).toEqual(["Bozo", "Patillas", "Sub mentón / mentón"]);
  });

  it("una zona sin exclusiones trae el array vacío", () => {
    const grupos = agruparZonasPorCategoria(ZONAS, EXCLUSIONES);
    const gluteos = grupos.grande.find((z) => z.name === "Glúteos")!;
    expect(gluteos.exclusions).toEqual([]);
  });

  it("no rompe con listas vacías", () => {
    expect(agruparZonasPorCategoria([], [])).toEqual({ grande: [], mediana: [], chica: [] });
  });
});

describe("filasDeExclusion", () => {
  it("escribe las dos direcciones del par", () => {
    expect(filasDeExclusion("A", ["B"])).toEqual([
      { zoneId: "A", excludesZoneId: "B" },
      { zoneId: "B", excludesZoneId: "A" },
    ]);
  });

  it("con varias zonas, escribe las dos direcciones de cada una", () => {
    const filas = filasDeExclusion("A", ["B", "C"]);
    expect(filas).toHaveLength(4);
    expect(filas).toEqual(
      expect.arrayContaining([
        { zoneId: "A", excludesZoneId: "B" },
        { zoneId: "B", excludesZoneId: "A" },
        { zoneId: "A", excludesZoneId: "C" },
        { zoneId: "C", excludesZoneId: "A" },
      ]),
    );
  });

  it("sin exclusiones no escribe nada", () => {
    expect(filasDeExclusion("A", [])).toEqual([]);
  });
});

describe("guardarExclusiones", () => {
  /** Doble liviano de Db: registra qué se llamó y en qué orden, sin tocar Postgres. */
  function fakeDb() {
    const llamadas: string[] = [];
    let valoresInsertados: unknown = null;
    const tx = {
      delete: vi.fn(() => {
        llamadas.push("tx.delete");
        return { where: vi.fn(() => Promise.resolve()) };
      }),
      insert: vi.fn(() => {
        llamadas.push("tx.insert");
        return {
          values: vi.fn((v: unknown) => {
            valoresInsertados = v;
            return Promise.resolve();
          }),
        };
      }),
    };
    const db = {
      // fuera de la transacción: si esto se llama, el borrado/alta no está
      // protegido por la transacción y es exactamente el antipatrón de
      // promotions.repo.ts que el brief pide no repetir.
      delete: vi.fn(() => {
        llamadas.push("db.delete SIN transacción");
        return { where: vi.fn(() => Promise.resolve()) };
      }),
      insert: vi.fn(() => {
        llamadas.push("db.insert SIN transacción");
        return { values: vi.fn(() => Promise.resolve()) };
      }),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        llamadas.push("transaction");
        return fn(tx);
      }),
    };
    return { db, llamadas, getValoresInsertados: () => valoresInsertados };
  }

  it("corre dentro de db.transaction, nunca fuera", async () => {
    const { db, llamadas } = fakeDb();
    await guardarExclusiones(db as never, "A", ["B"]);
    expect(llamadas).toContain("transaction");
    expect(llamadas).not.toContain("db.delete SIN transacción");
    expect(llamadas).not.toContain("db.insert SIN transacción");
  });

  it("borra antes de insertar, dentro de la misma transacción", async () => {
    const { db, llamadas } = fakeDb();
    await guardarExclusiones(db as never, "A", ["B"]);
    expect(llamadas.indexOf("tx.delete")).toBeGreaterThanOrEqual(0);
    expect(llamadas.indexOf("tx.insert")).toBeGreaterThan(llamadas.indexOf("tx.delete"));
  });

  it("al reemplazar exclusiones (quitar C, dejar B) inserta solo los pares de B", async () => {
    const { db, getValoresInsertados } = fakeDb();
    await guardarExclusiones(db as never, "A", ["B"]);
    expect(getValoresInsertados()).toEqual(filasDeExclusion("A", ["B"]));
  });

  it("si la nueva lista queda vacía, no llama a insert", async () => {
    const { db, llamadas } = fakeDb();
    await guardarExclusiones(db as never, "A", []);
    expect(llamadas).toContain("tx.delete");
    expect(llamadas).not.toContain("tx.insert");
  });
});

describe("nombreDeZonaEnUso", () => {
  const activas = [
    { id: "z1", name: "Axila" },
    { id: "z2", name: "Bozo" },
  ];

  it("detecta un nombre ya usado por una zona activa", () => {
    expect(nombreDeZonaEnUso(activas, "Axila")).toBe(true);
  });

  it("no distingue mayúsculas/minúsculas ni espacios extra", () => {
    expect(nombreDeZonaEnUso(activas, "  AXILA  ")).toBe(true);
  });

  it("no marca colisión con un nombre nuevo", () => {
    expect(nombreDeZonaEnUso(activas, "Ombligo")).toBe(false);
  });

  it("al editar, no choca contra sí misma (excludeId)", () => {
    expect(nombreDeZonaEnUso(activas, "Axila", "z1")).toBe(false);
  });

  it("al editar, sigue chocando contra OTRA zona activa", () => {
    expect(nombreDeZonaEnUso(activas, "Bozo", "z1")).toBe(true);
  });
});

describe("leerConfig", () => {
  const filaCompleta = {
    priceGrande: 19000, priceMediana: 17000, priceChica: 12000,
    pricingMinutesGrande: 10, pricingMinutesMediana: 7, pricingMinutesChica: 5,
    tier1RatePerMinute: 1200, tier2RatePerMinute: 1000,
    slotMinutesFemaleGrande: 9, slotMinutesFemaleMediana: 6, slotMinutesFemaleChica: 3,
    slotMinutesMaleGrande: 10, slotMinutesMaleMediana: 8, slotMinutesMaleChica: 5,
    slotRoundingStep: 5, slotMinimumMinutes: 10,
    packSessions: 3, packDiscountPercentage: 15, packRoundingBase: 1000,
  };

  function dbConFila(fila: typeof filaCompleta | undefined) {
    return {
      select: () => ({
        from: () => ({
          limit: () => Promise.resolve(fila ? [fila] : []),
        }),
      }),
    };
  }

  it("mapea las 19 columnas planas al objeto anidado DepilationConfig", async () => {
    const config = await leerConfig(dbConFila(filaCompleta) as never);
    const esperado: DepilationConfig = {
      precioLista: { grande: 19000, mediana: 17000, chica: 12000 },
      minutosPrecio: { grande: 10, mediana: 7, chica: 5 },
      tarifaEscalon1: 1200,
      tarifaEscalon2: 1000,
      minutosTurno: {
        mujer: { grande: 9, mediana: 6, chica: 3 },
        hombre: { grande: 10, mediana: 8, chica: 5 },
      },
      redondeoTurno: 5,
      turnoMinimo: 10,
      packSesiones: 3,
      packDescuentoPct: 15,
      packRedondeo: 1000,
    };
    expect(config).toEqual(esperado);
  });

  it("sin fila, falla ruidosamente en vez de devolver ceros/undefined", async () => {
    await expect(leerConfig(dbConFila(undefined) as never)).rejects.toThrow();
  });
});

describe("zonaBody", () => {
  const valido = { name: "Axila", category: "chica" as const, displayOrder: 1 };

  it("acepta una zona válida", () => {
    expect(zonaBody.safeParse(valido).success).toBe(true);
  });

  it("rechaza category fuera de grande|mediana|chica, con mensaje en castellano", () => {
    const r = zonaBody.safeParse({ ...valido, category: "enorme" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/grande, mediana o chica/i);
      expect(r.error.issues[0]?.message).not.toMatch(/invalid enum|expected/i);
    }
  });

  it("rechaza nombre vacío, con mensaje en castellano", () => {
    const r = zonaBody.safeParse({ ...valido, name: "" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/obligatorio/i);
  });

  it("rechaza displayOrder negativo, con mensaje en castellano", () => {
    const r = zonaBody.safeParse({ ...valido, displayOrder: -1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/no puede ser negativo/i);
  });
});

describe("estadoBody", () => {
  it("acepta isActive true/false", () => {
    expect(estadoBody.safeParse({ isActive: true }).success).toBe(true);
    expect(estadoBody.safeParse({ isActive: false }).success).toBe(true);
  });

  it("rechaza un valor que no es booleano", () => {
    expect(estadoBody.safeParse({ isActive: "true" }).success).toBe(false);
  });
});

describe("exclusionesBody", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";

  it("acepta una lista de uuids", () => {
    expect(exclusionesBody.safeParse({ excludes: [A, B] }).success).toBe(true);
  });

  it("acepta lista vacía (quitar todas las exclusiones)", () => {
    expect(exclusionesBody.safeParse({ excludes: [] }).success).toBe(true);
  });

  it("rechaza un id que no es uuid, con mensaje en castellano", () => {
    const r = exclusionesBody.safeParse({ excludes: ["no-es-un-uuid"] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/no es válida/i);
  });

  it("rechaza una zona repetida en la lista", () => {
    const r = exclusionesBody.safeParse({ excludes: [A, A] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/repetida/i);
  });
});

describe("configBody", () => {
  const valido = {
    priceGrande: 19000, priceMediana: 17000, priceChica: 12000,
    pricingMinutesGrande: 10, pricingMinutesMediana: 7, pricingMinutesChica: 5,
    tier1RatePerMinute: 1200, tier2RatePerMinute: 1000,
    slotMinutesFemaleGrande: 9, slotMinutesFemaleMediana: 6, slotMinutesFemaleChica: 3,
    slotMinutesMaleGrande: 10, slotMinutesMaleMediana: 8, slotMinutesMaleChica: 5,
    slotRoundingStep: 5, slotMinimumMinutes: 10,
    packSessions: 3, packDiscountPercentage: 15, packRoundingBase: 1000,
  };

  it("acepta una config válida", () => {
    expect(configBody.safeParse(valido).success).toBe(true);
  });

  it("rechaza packDiscountPercentage: 150, con mensaje en castellano", () => {
    const r = configBody.safeParse({ ...valido, packDiscountPercentage: 150 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/no puede superar el 100/i);
      expect(r.error.issues[0]?.message).not.toMatch(/less than or equal/i);
    }
  });

  it("acepta packDiscountPercentage: 0 (no es 'positive', es un porcentaje)", () => {
    expect(configBody.safeParse({ ...valido, packDiscountPercentage: 0 }).success).toBe(true);
  });

  it("rechaza slotMinimumMinutes: 0 — el turno mínimo tiene que ser >= 1", () => {
    const r = configBody.safeParse({ ...valido, slotMinimumMinutes: 0 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/mayor a cero/i);
      expect(r.error.issues[0]?.message).not.toMatch(/greater than/i);
    }
  });

  it("rechaza un entero no positivo en cualquier otro campo de precio/minutos", () => {
    const r = configBody.safeParse({ ...valido, priceGrande: 0 });
    expect(r.success).toBe(false);
  });

  it("rechaza un valor no entero, con mensaje en castellano", () => {
    const r = configBody.safeParse({ ...valido, priceGrande: 19000.5 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/entero/i);
      expect(r.error.issues[0]?.message).not.toMatch(/expected|received/i);
    }
  });
});

describe("GET /config sin token", () => {
  it("devuelve 401", async () => {
    const res = await depilacionRouter.request("/config", {}, {} as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });
});

describe("GET /zonas sin token", () => {
  it("devuelve 401", async () => {
    const res = await depilacionRouter.request("/zonas", {}, {} as never);
    expect(res.status).toBe(401);
  });
});
