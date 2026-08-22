import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, ilike, inArray, or } from "drizzle-orm";
import {
  depilacionRouter,
  zonaBody,
  estadoBody,
  exclusionesBody,
  configBody,
  cotizarBody,
  comboDepilacionBody,
} from "./depilacion";
import {
  agruparZonasPorCategoria,
  filasDeExclusion,
  nombreDeZonaEnUso,
  leerConfig,
  guardarExclusiones,
  exclusionesParaMotor,
  conflictoEnSeleccion,
  precioFormulaDeCombo,
  assembleDepilationCombo,
} from "../../repositories/depilacion.repo";
import * as schema from "../../db/schema";
import { bodyZone, zoneExclusion, depilationCombo, depilationComboZone } from "../../db/schema";
import type { Db } from "../../db/client";
import type { AppBindings } from "../../env";
import type { DepilationConfig } from "../../lib/depilation-pricing";

// ── Harness de integración contra Postgres local ────────────────────────────
// Casos 1, 2 y "borra las dos direcciones" del guardado de exclusiones son
// validaciones que viven en la base (FK, índice único parcial, la propia
// simetría del DELETE): un doble de `Db` que no ejecuta SQL de verdad no
// puede detectar una regresión ahí — solo puede detectar que el código
// *llamó* a delete/insert, no que el WHERE hizo lo correcto. Por eso estos
// bloques corren contra el Postgres local de `npm run db:up` (mismo que usa
// `wrangler dev`), igual que documenta el CLAUDE.md del repo para QA manual.
// Si no hay DB levantada, estos tests fallan con un error de conexión, no en
// silencio — señal correcta de "correé `npm run db:up` primero".
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA_PREFIX = "ZZ_QA_DEPILACION_TEST_";

const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const testDb = drizzle(pgClient, { schema }) as unknown as Db;

const ADMIN_ENV = {
  HYPERDRIVE: { connectionString: LOCAL_DB_URL },
  API_KEY: "qa-depilacion-test-key",
} as unknown as AppBindings;
const ADMIN_HEADERS = {
  "x-api-key": "qa-depilacion-test-key",
  "Content-Type": "application/json",
};

// `depilacionRouter.request(...)` a secas NO pasa por `app.onError` de
// index.ts (ese handler solo está registrado en el Hono raíz) — un error
// tirado con `badRequest()`/`conflict()`/`notFound()` sale con el manejo por
// default de Hono (texto plano), no como `{ error: "..." }`. Para que los
// tests de abajo verifiquen el contrato JSON real que ve el front, se monta
// el router bajo un Hono con el MISMO onError que index.ts (copiado, no
// importado, para no engancharse a cambios ahí).
const testApp = new Hono<{ Bindings: AppBindings }>();
testApp.onError((err, c) => {
  if ("status" in err && typeof err.status === "number") {
    return c.json(
      { error: err.message },
      err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502,
    );
  }
  return c.json({ error: "Internal server error" }, 500);
});
testApp.route("/", depilacionRouter);

async function crearZonaQA(nombre: string, isActive = true) {
  const [z] = await testDb
    .insert(bodyZone)
    .values({ name: `${QA_PREFIX}${nombre}`, category: "chica", displayOrder: 0, isActive })
    .returning({ id: bodyZone.id, name: bodyZone.name });
  if (!z) throw new Error("no se pudo crear la zona QA");
  return z;
}

// Barre cualquier basura de una corrida anterior que haya muerto antes de
// limpiar (ej. Ctrl+C a mitad), y cierra la conexión al final del archivo.
beforeAll(async () => {
  await testDb.delete(bodyZone).where(ilike(bodyZone.name, `${QA_PREFIX}%`));
});
afterAll(async () => {
  await testDb.delete(bodyZone).where(ilike(bodyZone.name, `${QA_PREFIX}%`));
  await pgClient.end();
});

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

  it("con una nueva selección, inserta exactamente las filas de filasDeExclusion", async () => {
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

// El fakeDb de arriba resuelve `tx.delete().where(...)` SIN mirar el
// argumento de `.where()` — por diseño: solo puede confirmar que se llamó a
// delete/insert en el orden correcto, dentro de la transacción. No puede
// detectar si el WHERE real (`or(eq(zoneId,...), eq(excludesZoneId,...))`)
// deja de cubrir alguna de las dos direcciones. Ese caso concreto —"borra
// las dos direcciones, no una"— se prueba acá contra Postgres real, y SÍ se
// verificó por mutación (romper el `or(...)` real, confirmar que este test
// falla, restaurar, confirmar que vuelve a pasar) — evidencia en
// task-4-report.md.
describe("guardarExclusiones — borra las dos direcciones (integración real contra Postgres local)", () => {
  let A = "";
  let B = "";
  let C = "";

  beforeAll(async () => {
    A = (await crearZonaQA("BORRA_A")).id;
    B = (await crearZonaQA("BORRA_B")).id;
    C = (await crearZonaQA("BORRA_C")).id;
  });

  afterAll(async () => {
    await testDb.delete(bodyZone).where(inArray(bodyZone.id, [A, B, C]));
  });

  async function filasQueTocanA() {
    return testDb
      .select({ zoneId: zoneExclusion.zoneId, excludesZoneId: zoneExclusion.excludesZoneId })
      .from(zoneExclusion)
      .where(or(eq(zoneExclusion.zoneId, A), eq(zoneExclusion.excludesZoneId, A)));
  }

  it("escribe las dos direcciones del par contra la base real", async () => {
    await guardarExclusiones(testDb, A, [B]);
    const filas = await filasQueTocanA();
    expect(filas).toHaveLength(2);
    expect(filas).toEqual(
      expect.arrayContaining([
        { zoneId: A, excludesZoneId: B },
        { zoneId: B, excludesZoneId: A },
      ]),
    );
  });

  it("al sacar una zona de la selección (B), borra las DOS filas del par viejo — no una", async () => {
    await guardarExclusiones(testDb, A, [B, C]);
    await guardarExclusiones(testDb, A, [C]); // se saca B de la selección

    const filas = await filasQueTocanA();

    // Ninguna fila debe mencionar a B, en ninguna dirección.
    expect(filas.some((f) => f.zoneId === B || f.excludesZoneId === B)).toBe(false);
    // El par con C sigue, en las dos direcciones.
    expect(filas).toHaveLength(2);
    expect(filas).toEqual(
      expect.arrayContaining([
        { zoneId: A, excludesZoneId: C },
        { zoneId: C, excludesZoneId: A },
      ]),
    );
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
  // 19 valores CENTINELA, todos distintos entre sí (101..119, uno por
  // columna, en el mismo orden en que aparecen en el schema/brief). No son
  // realistas a propósito: si el mapeo cruzara dos columnas — el riesgo real
  // que marca el spec, ej. confundir `minutosPrecio` (unisex) con
  // `minutosTurno.hombre` — con valores realistas como 10/10 o 5/5 el
  // `toEqual` de abajo podría pasar igual por coincidencia. Con valores
  // únicos, cualquier cruce mueve un número a la casilla equivocada y el
  // test lo detecta.
  const filaCompleta = {
    priceGrande: 101, priceMediana: 102, priceChica: 103,
    pricingMinutesGrande: 104, pricingMinutesMediana: 105, pricingMinutesChica: 106,
    tier1RatePerMinute: 107, tier2RatePerMinute: 108,
    slotMinutesFemaleGrande: 109, slotMinutesFemaleMediana: 110, slotMinutesFemaleChica: 111,
    slotMinutesMaleGrande: 112, slotMinutesMaleMediana: 113, slotMinutesMaleChica: 114,
    slotRoundingStep: 115, slotMinimumMinutes: 116,
    packSessions: 117, packDiscountPercentage: 118, packRoundingBase: 119,
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
      precioLista: { grande: 101, mediana: 102, chica: 103 },
      minutosPrecio: { grande: 104, mediana: 105, chica: 106 },
      tarifaEscalon1: 107,
      tarifaEscalon2: 108,
      minutosTurno: {
        mujer: { grande: 109, mediana: 110, chica: 111 },
        hombre: { grande: 112, mediana: 113, chica: 114 },
      },
      redondeoTurno: 115,
      turnoMinimo: 116,
      packSesiones: 117,
      packDescuentoPct: 118,
      packRedondeo: 119,
    };
    expect(config).toEqual(esperado);

    // Chequeo extra, explícito: los 19 valores del objeto plano de entrada
    // son todos distintos entre sí. Si alguna vez alguien "simplifica" el
    // fixture y sin querer repite un valor entre familias de columnas, este
    // assert avisa ANTES de que el toEqual de arriba deje de ser confiable.
    const valores = Object.values(filaCompleta);
    expect(new Set(valores).size).toBe(valores.length);
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

// ── Hallazgo 1: PUT /zonas/:id/exclusiones tiene que validar existencia ────
// Antes: `:id` inexistente + excludes:[] respondía 200 sin haber hecho nada
// (éxito falso), y un id inexistente/inactivo en `excludes` rompía el
// INSERT por la FK como un 500 genérico. Integración real porque la validez
// depende de qué hay en la tabla, no de una regla en memoria.
describe("PUT /zonas/:id/exclusiones — validación de existencia (integración real)", () => {
  let zonaId = "";

  beforeAll(async () => {
    zonaId = (await crearZonaQA("EXCL_BASE")).id;
  });

  afterAll(async () => {
    await testDb.delete(bodyZone).where(eq(bodyZone.id, zonaId));
  });

  it(":id que no es ninguna zona -> 404, incluso con excludes vacío", async () => {
    const inexistente = "00000000-0000-0000-0000-000000000000";
    const res = await testApp.request(
      `/zonas/${inexistente}/exclusiones`,
      { method: "PUT", headers: ADMIN_HEADERS, body: JSON.stringify({ excludes: [] }) },
      ADMIN_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("excludes con un uuid que no es ninguna zona -> 400 nombrando cuál", async () => {
    const fantasma = "11111111-2222-3333-4444-555555555555";
    const res = await testApp.request(
      `/zonas/${zonaId}/exclusiones`,
      { method: "PUT", headers: ADMIN_HEADERS, body: JSON.stringify({ excludes: [fantasma] }) },
      ADMIN_ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(fantasma);
  });

  it("excludes con una zona que existe pero está archivada -> 400", async () => {
    const inactiva = await crearZonaQA("EXCL_INACTIVA", false);
    try {
      const res = await testApp.request(
        `/zonas/${zonaId}/exclusiones`,
        { method: "PUT", headers: ADMIN_HEADERS, body: JSON.stringify({ excludes: [inactiva.id] }) },
        ADMIN_ENV,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(inactiva.id);
    } finally {
      await testDb.delete(bodyZone).where(eq(bodyZone.id, inactiva.id));
    }
  });

  it("excludes con una zona activa real -> 200 y no revienta", async () => {
    const otra = await crearZonaQA("EXCL_VALIDA");
    try {
      const res = await testApp.request(
        `/zonas/${zonaId}/exclusiones`,
        { method: "PUT", headers: ADMIN_HEADERS, body: JSON.stringify({ excludes: [otra.id] }) },
        ADMIN_ENV,
      );
      expect(res.status).toBe(200);
    } finally {
      // Cascada: borrar la zona borra sus filas de zone_exclusion.
      await testDb.delete(bodyZone).where(eq(bodyZone.id, otra.id));
    }
  });
});

// ── Hallazgo 2: PATCH /zonas/:id/estado no puede reventar al reactivar ────
// Antes: reactivar una zona archivada cuyo nombre ya lo tiene una activa
// chocaba contra `ux_body_zone_name` (único parcial WHERE is_active) y
// salía como 500 en vez del 409 que ya usan POST/PATCH /zonas. El índice es
// parcial, así que crear una fila activa y otra archivada con el MISMO
// nombre es válido — es exactamente el escenario del bug.
describe("PATCH /zonas/:id/estado — colisión de nombre al reactivar (integración real)", () => {
  let activaId = "";
  let archivadaId = "";
  const nombreCompartido = `${QA_PREFIX}ESTADO_COLISION`;

  beforeAll(async () => {
    const [act] = await testDb
      .insert(bodyZone)
      .values({ name: nombreCompartido, category: "chica", displayOrder: 0, isActive: true })
      .returning({ id: bodyZone.id });
    const [arch] = await testDb
      .insert(bodyZone)
      .values({ name: nombreCompartido, category: "chica", displayOrder: 0, isActive: false })
      .returning({ id: bodyZone.id });
    activaId = act!.id;
    archivadaId = arch!.id;
  });

  afterAll(async () => {
    await testDb.delete(bodyZone).where(inArray(bodyZone.id, [activaId, archivadaId]));
  });

  it("reactivar la archivada con nombre ya usado por la activa -> 409, no 500", async () => {
    const res = await testApp.request(
      `/zonas/${archivadaId}/estado`,
      { method: "PATCH", headers: ADMIN_HEADERS, body: JSON.stringify({ isActive: true }) },
      ADMIN_ENV,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ya existe una zona activa/i);
  });

  it("archivar (isActive:false) no choca aunque el nombre esté repetido", async () => {
    const res = await testApp.request(
      `/zonas/${activaId}/estado`,
      { method: "PATCH", headers: ADMIN_HEADERS, body: JSON.stringify({ isActive: false }) },
      ADMIN_ENV,
    );
    expect(res.status).toBe(200);
    // Reactivarla de nuevo: ya no hay otra activa con ese nombre (se acaba
    // de archivar a sí misma), así que esto SÍ tiene que andar.
    const res2 = await testApp.request(
      `/zonas/${activaId}/estado`,
      { method: "PATCH", headers: ADMIN_HEADERS, body: JSON.stringify({ isActive: true }) },
      ADMIN_ENV,
    );
    expect(res2.status).toBe(200);
  });

  it("PATCH estado con id inexistente -> 404", async () => {
    const inexistente = "00000000-0000-0000-0000-000000000000";
    const res = await testApp.request(
      `/zonas/${inexistente}/estado`,
      { method: "PATCH", headers: ADMIN_HEADERS, body: JSON.stringify({ isActive: true }) },
      ADMIN_ENV,
    );
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Task 5: cotización y CRUD de combos
// ══════════════════════════════════════════════════════════════════════════

describe("exclusionesParaMotor", () => {
  it("mapea zoneId/excludesZoneId a zonaId/excluyeA", () => {
    expect(exclusionesParaMotor([{ zoneId: "A", excludesZoneId: "B" }])).toEqual([
      { zonaId: "A", excluyeA: "B" },
    ]);
  });

  it("lista vacía da lista vacía", () => {
    expect(exclusionesParaMotor([])).toEqual([]);
  });
});

describe("conflictoEnSeleccion", () => {
  const exclusiones = [
    { zonaId: "pierna", excluyeA: "media-pierna" },
    { zonaId: "media-pierna", excluyeA: "pierna" },
  ];

  it("detecta el par cuando las dos zonas están en la selección", () => {
    const c = conflictoEnSeleccion(["pierna", "media-pierna", "axila"], exclusiones);
    expect(c).not.toBeNull();
    expect([c?.zonaId, c?.excluyeA].sort()).toEqual(["media-pierna", "pierna"]);
  });

  it("no marca conflicto si solo una de las dos está en la selección", () => {
    expect(conflictoEnSeleccion(["pierna", "axila"], exclusiones)).toBeNull();
  });

  it("no marca conflicto con selección vacía", () => {
    expect(conflictoEnSeleccion([], exclusiones)).toBeNull();
  });
});

describe("precioFormulaDeCombo", () => {
  // Config real del seed 1.35.0: price_grande=19000, pricing_minutes_chica=5,
  // tier1=1200, tier2=1000. Con esta config, agregar 1 zona fantasma "chica"
  // siempre cae en escalón 2 (5×1000=$5.000) si ya hay 2+ zonas cargadas.
  const config: DepilationConfig = {
    precioLista: { grande: 19000, mediana: 17000, chica: 12000 },
    minutosPrecio: { grande: 10, mediana: 7, chica: 5 },
    tarifaEscalon1: 1200,
    tarifaEscalon2: 1000,
    minutosTurno: { mujer: { grande: 9, mediana: 6, chica: 3 }, hombre: { grande: 10, mediana: 8, chica: 5 } },
    redondeoTurno: 5,
    turnoMinimo: 10,
    packSesiones: 3,
    packDescuentoPct: 15,
    packRedondeo: 1000,
  };

  const zona = (id: string, categoria: "grande" | "mediana" | "chica") => ({
    id,
    nombre: id,
    categoria,
  });

  it("sin zonas a elección, es la fórmula tal cual (Cuerpo Full: $86.000)", () => {
    const zonas = [
      ...Array.from({ length: 5 }, (_, i) => zona(`g${i}`, "grande" as const)),
      ...Array.from({ length: 5 }, (_, i) => zona(`c${i}`, "chica" as const)),
    ];
    expect(precioFormulaDeCombo(zonas, 0, config)).toBe(86000);
  });

  it("con 1 zona a elección, suma una zona chica extra (Cuerpo Completo: $61.000)", () => {
    const zonas = [
      ...Array.from({ length: 3 }, (_, i) => zona(`g${i}`, "grande" as const)),
      ...Array.from({ length: 3 }, (_, i) => zona(`c${i}`, "chica" as const)),
    ];
    expect(precioFormulaDeCombo(zonas, 1, config)).toBe(61000);
  });

  it("con 1 zona a elección, suma una zona chica extra (Esenciales: $51.000)", () => {
    const zonas = [
      ...Array.from({ length: 2 }, (_, i) => zona(`g${i}`, "grande" as const)),
      ...Array.from({ length: 3 }, (_, i) => zona(`c${i}`, "chica" as const)),
    ];
    expect(precioFormulaDeCombo(zonas, 1, config)).toBe(51000);
  });
});

// ── Ronda de fixes 1, punto 1 (Important) ───────────────────────────────────
// "Un combo guardado nunca muestra un precio pegado" es la razón de ser de
// todo el diseño (§4.5-4.7 del spec) — y el mutante que probó el revisor
// (sacar el `combo.kind === "pack_fijo" ?` de `assembleDepilationCombo`) no
// lo detectaba ningún test existente, porque el CHECK `ck_dc_precio_guardado`
// de la base ya garantiza que un `guardado` real nunca tiene `fixed_price`
// cargado — se probó a mano: crearlo como `pack_fijo` con precio y después
// `UPDATE depilation_combo SET kind = 'guardado'` es rechazado por Postgres
// ("violates check constraint ck_dc_precio_guardado"), así que esa vía de
// integración real es imposible por diseño. Por eso este test prueba
// DIRECTAMENTE la función pura que arma la respuesta, fabricando la fila
// "imposible" que la base nunca dejaría existir — es la única forma de
// ejercitar esa línea de defensa en profundidad.
describe("assembleDepilationCombo — invariante central: un guardado nunca muestra un precio pegado", () => {
  const config: DepilationConfig = {
    precioLista: { grande: 19000, mediana: 17000, chica: 12000 },
    minutosPrecio: { grande: 10, mediana: 7, chica: 5 },
    tarifaEscalon1: 1200,
    tarifaEscalon2: 1000,
    minutosTurno: { mujer: { grande: 9, mediana: 6, chica: 3 }, hombre: { grande: 10, mediana: 8, chica: 5 } },
    redondeoTurno: 5,
    turnoMinimo: 10,
    packSesiones: 3,
    packDescuentoPct: 15,
    packRedondeo: 1000,
  };
  const zonaAxila = { id: "z1", nombre: "Axila", categoria: "chica" as const };

  it("con un guardado que (la base nunca dejaría, pero) trae fixed_price, precioFinal es el calculado — nunca el precio pegado", () => {
    const filaImposible = {
      id: "c1",
      name: "Guardado con precio fantasma",
      description: null,
      kind: "guardado",
      fixedPrice: "999999.00",
      fixedDurationMinutes: null,
      choiceZoneCount: 0,
      isPublishedWeb: false,
      displayOrder: 0,
      isActive: true,
    };
    const resultado = assembleDepilationCombo(filaImposible, [zonaAxila], config);
    expect(resultado.precioFinal).toBe(resultado.precioCalculado);
    expect(resultado.precioFinal).not.toBe(999999);
  });

  it("un pack_fijo SÍ usa fixedPrice como precioFinal (caso normal, de control)", () => {
    const filaPack = {
      id: "c2",
      name: "Pack normal",
      description: null,
      kind: "pack_fijo",
      fixedPrice: "20000.00",
      fixedDurationMinutes: null,
      choiceZoneCount: 0,
      isPublishedWeb: false,
      displayOrder: 0,
      isActive: true,
    };
    const resultado = assembleDepilationCombo(filaPack, [zonaAxila], config);
    expect(resultado.precioFinal).toBe(20000);
  });
});

describe("cotizarBody", () => {
  const A = "11111111-1111-1111-1111-111111111111";

  it("acepta zonaIds + sexo válidos", () => {
    expect(cotizarBody.safeParse({ zonaIds: [A], sexo: "mujer" }).success).toBe(true);
  });

  it("acepta zonaIds vacío (selección vacía es válida)", () => {
    expect(cotizarBody.safeParse({ zonaIds: [], sexo: "hombre" }).success).toBe(true);
  });

  it("rechaza un sexo fuera de mujer|hombre, con mensaje en castellano", () => {
    const r = cotizarBody.safeParse({ zonaIds: [A], sexo: "otro" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/mujer o hombre/i);
  });

  it("rechaza un zonaId que no es uuid", () => {
    expect(cotizarBody.safeParse({ zonaIds: ["no-es-uuid"], sexo: "mujer" }).success).toBe(false);
  });

  it("rechaza zonaIds repetidos, con mensaje en castellano", () => {
    const r = cotizarBody.safeParse({ zonaIds: [A, A], sexo: "mujer" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/repetida/i);
  });
});

describe("comboDepilacionBody", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const guardadoValido = { name: "Combo X", kind: "guardado" as const, zonaIds: [A] };
  const packFijoValido = { name: "Pack X", kind: "pack_fijo" as const, fixedPrice: 50000, zonaIds: [A] };

  it("acepta un combo guardado sin precio", () => {
    expect(comboDepilacionBody.safeParse(guardadoValido).success).toBe(true);
  });

  it("acepta un pack fijo con precio", () => {
    expect(comboDepilacionBody.safeParse(packFijoValido).success).toBe(true);
  });

  it("rechaza un guardado con fixedPrice cargado, con mensaje en castellano", () => {
    const r = comboDepilacionBody.safeParse({ ...guardadoValido, fixedPrice: 1000 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/no lleva precio propio/i);
  });

  it("rechaza un pack_fijo sin fixedPrice", () => {
    const r = comboDepilacionBody.safeParse({ name: "Pack X", kind: "pack_fijo", zonaIds: [A] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/necesita el precio fijo/i);
  });

  it("rechaza zonaIds vacío", () => {
    const r = comboDepilacionBody.safeParse({ ...guardadoValido, zonaIds: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/al menos una zona/i);
  });

  it("rechaza una zona repetida", () => {
    const r = comboDepilacionBody.safeParse({ ...guardadoValido, zonaIds: [A, A] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/repetida/i);
  });

  it("acepta dos zonas distintas", () => {
    expect(comboDepilacionBody.safeParse({ ...guardadoValido, zonaIds: [A, B] }).success).toBe(true);
  });

  it("rechaza choiceZoneCount > 0 en un guardado, con mensaje en castellano", () => {
    const r = comboDepilacionBody.safeParse({ ...guardadoValido, choiceZoneCount: 1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/no puede tener zonas a elección/i);
  });

  it("acepta choiceZoneCount: 0 en un guardado", () => {
    expect(comboDepilacionBody.safeParse({ ...guardadoValido, choiceZoneCount: 0 }).success).toBe(true);
  });

  it("acepta choiceZoneCount > 0 en un pack_fijo", () => {
    expect(comboDepilacionBody.safeParse({ ...packFijoValido, choiceZoneCount: 1 }).success).toBe(true);
  });
});

// ── Helpers contra el catálogo REAL sembrado por la migración 1.35.0 ───────
// A diferencia de crearZonaQA (zonas descartables para probar CRUD), estos
// tests de cotización y de los packs fijos necesitan las zonas y los 3 packs
// reales — no tiene sentido inventar una categoría o un pack de prueba
// cuando lo que se está probando es que la fórmula real da los números
// reales del PDF.
async function idDeZonaReal(nombre: string): Promise<string> {
  const [z] = await testDb.select({ id: bodyZone.id }).from(bodyZone).where(eq(bodyZone.name, nombre)).limit(1);
  if (!z) throw new Error(`no está seedeada la zona real "${nombre}" (¿corriste npm run db:up?)`);
  return z.id;
}

async function idsDeZonasDelCombo(nombreCombo: string): Promise<string[]> {
  const [combo] = await testDb
    .select({ id: depilationCombo.id })
    .from(depilationCombo)
    .where(eq(depilationCombo.name, nombreCombo))
    .limit(1);
  if (!combo) throw new Error(`no está seedeado el combo "${nombreCombo}"`);
  const rows = await testDb
    .select({ zoneId: depilationComboZone.zoneId })
    .from(depilationComboZone)
    .where(eq(depilationComboZone.comboId, combo.id));
  return rows.map((r) => r.zoneId);
}

type Cotizacion = {
  total: number;
  lineas: unknown[];
  duracionMinutos: number;
  pack: { sesiones: number; total: number; ahorro: number };
  packFijo: { id: string; nombre: string; precio: number; precioFormula: number } | null;
};

async function cotizarRaw(zonaIds: string[], sexo: "mujer" | "hombre") {
  return testApp.request(
    "/cotizar",
    { method: "POST", headers: ADMIN_HEADERS, body: JSON.stringify({ zonaIds, sexo }) },
    ADMIN_ENV,
  );
}

async function cotizar(zonaIds: string[], sexo: "mujer" | "hombre"): Promise<Cotizacion> {
  const res = await cotizarRaw(zonaIds, sexo);
  if (res.status !== 200) throw new Error(`cotizar devolvió ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Cotizacion>;
}

describe("POST /cotizar (integración real)", () => {
  let piernaId = "";
  let cavadoId = "";
  let axilaId = "";
  let mediaPiernaId = "";
  let zonasCuerpoFull: string[] = [];

  beforeAll(async () => {
    piernaId = await idDeZonaReal("Pierna entera");
    cavadoId = await idDeZonaReal("Cavado");
    axilaId = await idDeZonaReal("Axila");
    mediaPiernaId = await idDeZonaReal("Media pierna");
    zonasCuerpoFull = await idsDeZonasDelCombo("Cuerpo Full");
  });

  it("cotiza pierna + cavado + axila para hombre", async () => {
    const body = await cotizar([piernaId, cavadoId, axilaId], "hombre");
    expect(body.total).toBe(30000);
    expect(body.duracionMinutos).toBe(20); // 10 + 5 + 5
    expect(body.pack.total).toBe(77000); // 30000 × 3 × 0,85 = 76500 → 77000
    expect(body.pack.ahorro).toBe(13000); // 90000 − 77000
    expect(body.packFijo).toBeNull();
  });

  it("aplica el pack fijo cuando la selección coincide", async () => {
    const body = await cotizar(zonasCuerpoFull, "mujer");
    expect(body.packFijo).toMatchObject({ nombre: "Cuerpo Full", precio: 65000, precioFormula: 86000 });
    expect(body.total).toBe(65000);
  });

  it("rechaza una selección con dos zonas que se pisan", async () => {
    const res = await cotizarRaw([piernaId, mediaPiernaId], "mujer");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Media pierna");
  });

  it("rechaza un zonaId que no existe", async () => {
    const res = await cotizarRaw([crypto.randomUUID()], "mujer");
    expect(res.status).toBe(400);
  });

  it("selección vacía cotiza $0 sin romper", async () => {
    const body = await cotizar([], "mujer");
    expect(body.total).toBe(0);
    expect(body.duracionMinutos).toBe(0);
    expect(body.lineas).toEqual([]);
    expect(body.packFijo).toBeNull();
  });

  it("sin token -> 401", async () => {
    const res = await depilacionRouter.request(
      "/cotizar",
      { method: "POST", body: JSON.stringify({ zonaIds: [], sexo: "mujer" }) },
      {} as never,
    );
    expect(res.status).toBe(401);
  });
});

describe("Combos de depilación (integración real)", () => {
  let comboCreadoId = "";

  afterAll(async () => {
    if (comboCreadoId) {
      await testDb.delete(depilationCombo).where(eq(depilationCombo.id, comboCreadoId));
    }
  });

  it("GET /combos devuelve cada combo con su precio calculado, no guardado", async () => {
    const res = await testApp.request("/combos", { headers: ADMIN_HEADERS }, ADMIN_ENV);
    expect(res.status).toBe(200);
    const combos = (await res.json()) as Array<{
      name: string;
      kind: string;
      fixedPrice: number | null;
      precioCalculado: number;
      precioFinal: number;
    }>;
    const cuerpoFull = combos.find((c) => c.name === "Cuerpo Full");
    expect(cuerpoFull).toBeDefined();
    expect(cuerpoFull!.precioCalculado).toBe(86000);
    // El precio final del pack fijo es el fijo, NUNCA el calculado.
    expect(cuerpoFull!.precioFinal).toBe(65000);
  });

  it("ningún pack fijo cuesta más que su propia fórmula", async () => {
    const res = await testApp.request("/combos", { headers: ADMIN_HEADERS }, ADMIN_ENV);
    const combos = (await res.json()) as Array<{
      name: string;
      kind: string;
      fixedPrice: string | number | null;
      precioCalculado: number;
    }>;
    const packs = combos.filter((c) => c.kind === "pack_fijo");
    expect(packs).toHaveLength(3);
    for (const p of packs) {
      expect(Number(p.fixedPrice)).toBeLessThan(p.precioCalculado);
    }

    const porNombre = (n: string) => packs.find((p) => p.name === n)!;
    expect(porNombre("Cuerpo Full")).toMatchObject({ fixedPrice: 65000, precioCalculado: 86000 });
    expect(porNombre("Cuerpo Completo")).toMatchObject({ fixedPrice: 58000, precioCalculado: 61000 });
    expect(porNombre("Combo de Esenciales")).toMatchObject({ fixedPrice: 49000, precioCalculado: 51000 });
  });

  it("POST /combos con kind guardado y fixedPrice cargado -> 400", async () => {
    const axilaId = await idDeZonaReal("Axila");
    const res = await testApp.request(
      "/combos",
      {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({
          name: `${QA_PREFIX}GUARDADO_CON_PRECIO`,
          kind: "guardado",
          fixedPrice: 1000,
          zonaIds: [axilaId],
        }),
      },
      ADMIN_ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no lleva precio propio/i);
  });

  it("POST /combos sin zonas -> 400", async () => {
    const res = await testApp.request(
      "/combos",
      {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ name: `${QA_PREFIX}SIN_ZONAS`, kind: "guardado", zonaIds: [] }),
      },
      ADMIN_ENV,
    );
    expect(res.status).toBe(400);
  });

  // ── Ronda de fixes 1, punto 2 (Important) ─────────────────────────────────
  // `ux_depilation_combo_name` es UNIQUE (name) sobre toda la tabla; sin
  // chequearlo antes del INSERT/UPDATE, un nombre repetido rompía con un 500
  // genérico (probado en vivo por el revisor). Mismo agujero que se cerró
  // para `body_zone` en la ronda anterior — acá con el mismo criterio: 409,
  // no 500.
  it("POST /combos con un nombre ya usado -> 409, no 500", async () => {
    const axilaId = await idDeZonaReal("Axila");
    const res = await testApp.request(
      "/combos",
      {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ name: "Cuerpo Full", kind: "guardado", zonaIds: [axilaId] }),
      },
      ADMIN_ENV,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ya existe un combo/i);
  });

  it("PATCH /combos/:id con el nombre de OTRO combo -> 409; renombrar a su propio nombre sigue andando", async () => {
    const axilaId = await idDeZonaReal("Axila");
    const createRes = await testApp.request(
      "/combos",
      {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ name: `${QA_PREFIX}RENOMBRAR`, kind: "guardado", zonaIds: [axilaId] }),
      },
      ADMIN_ENV,
    );
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };
    try {
      const patchChocando = await testApp.request(
        `/combos/${id}`,
        {
          method: "PATCH",
          headers: ADMIN_HEADERS,
          body: JSON.stringify({ name: "Cuerpo Full", kind: "guardado", zonaIds: [axilaId] }),
        },
        ADMIN_ENV,
      );
      expect(patchChocando.status).toBe(409);

      // El excludeId tiene que evitar que un combo choque contra sí mismo
      // al "renombrarse" a su propio nombre actual (mismo caso que se
      // arregló para zonas: reactivar con el nombre propio no puede fallar).
      const patchMismoNombre = await testApp.request(
        `/combos/${id}`,
        {
          method: "PATCH",
          headers: ADMIN_HEADERS,
          body: JSON.stringify({ name: `${QA_PREFIX}RENOMBRAR`, kind: "guardado", zonaIds: [axilaId] }),
        },
        ADMIN_ENV,
      );
      expect(patchMismoNombre.status).toBe(200);
    } finally {
      await testDb.delete(depilationCombo).where(eq(depilationCombo.id, id));
    }
  });

  it("crea un combo guardado, lo edita y lo archiva", async () => {
    const axilaId = await idDeZonaReal("Axila");
    const cavadoId = await idDeZonaReal("Cavado");

    const createRes = await testApp.request(
      "/combos",
      {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ name: `${QA_PREFIX}GUARDADO_1`, kind: "guardado", zonaIds: [axilaId] }),
      },
      ADMIN_ENV,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      precioCalculado: number;
      precioFinal: number;
      zonas: unknown[];
    };
    comboCreadoId = created.id;
    // Un guardado nunca lee un precio propio: precioFinal === precioCalculado.
    expect(created.precioFinal).toBe(created.precioCalculado);
    expect(created.zonas).toHaveLength(1);

    const patchRes = await testApp.request(
      `/combos/${comboCreadoId}`,
      {
        method: "PATCH",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({
          name: `${QA_PREFIX}GUARDADO_1`,
          kind: "guardado",
          zonaIds: [axilaId, cavadoId],
        }),
      },
      ADMIN_ENV,
    );
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as { zonas: unknown[] };
    expect(updated.zonas).toHaveLength(2);

    const estadoRes = await testApp.request(
      `/combos/${comboCreadoId}/estado`,
      { method: "PATCH", headers: ADMIN_HEADERS, body: JSON.stringify({ isActive: false }) },
      ADMIN_ENV,
    );
    expect(estadoRes.status).toBe(200);
    const archived = (await estadoRes.json()) as { isActive: boolean };
    expect(archived.isActive).toBe(false);
  });

  it("PATCH /combos/:id con id inexistente -> 404", async () => {
    const axilaId = await idDeZonaReal("Axila");
    const inexistente = "00000000-0000-0000-0000-000000000000";
    const res = await testApp.request(
      `/combos/${inexistente}`,
      {
        method: "PATCH",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ name: "x", kind: "guardado", zonaIds: [axilaId] }),
      },
      ADMIN_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("PATCH /combos/:id/estado con id inexistente -> 404", async () => {
    const inexistente = "00000000-0000-0000-0000-000000000000";
    const res = await testApp.request(
      `/combos/${inexistente}/estado`,
      { method: "PATCH", headers: ADMIN_HEADERS, body: JSON.stringify({ isActive: false }) },
      ADMIN_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("GET /combos sin token -> 401", async () => {
    const res = await depilacionRouter.request("/combos", {}, {} as never);
    expect(res.status).toBe(401);
  });
});
