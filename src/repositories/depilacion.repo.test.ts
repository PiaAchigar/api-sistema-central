import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { like, notLike } from "drizzle-orm";
import * as schema from "../db/schema";
import { bodyZone } from "../db/schema";
import type { Db } from "../db/client";
import {
  assembleDepilationCombo,
  crearCombo,
  hardDeleteCombo,
  obtenerCombo,
  type DepilationComboRow,
} from "./depilacion.repo";
import type { DepilationConfig, ZonaParaCotizar } from "../lib/depilation-pricing";

/**
 * Task 4 (1.56.0): `obtenerCombo`/`assembleDepilationCombo` conectados con la
 * config real por sexo. Integración contra Postgres local — el mapeo
 * `aConfigAnidada` (columnas `female`/`male` de la base → `mujer`/`hombre`
 * del tipo) es justamente lo que un doble de `Db` no puede probar: hay que
 * leer la fila real.
 *
 * Excepción: el test de "cotiza con la fórmula del sexo que corresponde" NO
 * lee la config real — ver el comentario ahí sobre por qué.
 */
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_DEPILACION_REPO";

/** Mapa nombre → id de las zonas reales (excluye fixtures `ZZ_QA%` de otras
 *  suites: un `select` sin este filtro puede agarrar el fixture vivo de otro
 *  archivo). Se resuelve una vez; `idDeZonaReal` abajo lee de acá. */
async function zonasRealesPorNombre(): Promise<Map<string, string>> {
  const filas = await db
    .select({ id: bodyZone.id, name: bodyZone.name })
    .from(bodyZone)
    .where(notLike(bodyZone.name, "ZZ_QA%"));
  return new Map(filas.map((f) => [f.name, f.id]));
}

let esencialesId = "";

async function limpiarCombosQA() {
  const combos = await db
    .select({ id: schema.depilationCombo.id })
    .from(schema.depilationCombo)
    .where(like(schema.depilationCombo.name, `${QA}%`));
  for (const c of combos) await hardDeleteCombo(db, c.id);
}

beforeAll(async () => {
  await limpiarCombosQA();

  const zonas = await zonasRealesPorNombre();
  const idDeZonaReal = (nombre: string): string => {
    const id = zonas.get(nombre);
    if (!id) throw new Error(`no está seedeada la zona real "${nombre}" (¿corriste npm run db:up?)`);
    return id;
  };
  const grandeA = idDeZonaReal("Brazos");
  const grandeB = idDeZonaReal("Espalda");
  const chicaA = idDeZonaReal("Antebrazo");
  const chicaB = idDeZonaReal("Axila");
  const chicaC = idDeZonaReal("Barba");

  // §10-A: pack_fijo de 2 grandes + 3 chicas, con 1 zona a elección — el caso
  // exacto de "Combo de Esenciales" que el spec usa de ejemplo.
  const esenciales = await crearCombo(db, {
    name: `${QA}_ESENCIALES`,
    kind: "pack_fijo",
    fixedPrice: 49000,
    choiceZoneCount: 1,
    zonaIds: [grandeA, grandeB, chicaA, chicaB, chicaC],
  });
  esencialesId = esenciales!.id;
});

afterAll(async () => {
  await limpiarCombosQA();
  await pgClient.end();
});

describe("assembleDepilationCombo — por sexo (1.56.0)", () => {
  /**
   * §10-A: hoy el precio cuenta las zonas a elección (como fantasmas) pero la
   * duración NO. "Combo de Esenciales" tiene 5 zonas + 1 a elección: se agenda
   * como si fueran 5, y esos minutos se los come el turno siguiente.
   */
  it("el presupuesto de tiempo cuenta las zonas a elección", async () => {
    const combo = await obtenerCombo(db, esencialesId, "mujer");
    // 2 grandes (9) + 3 chicas (3) + 1 de regalo, chica (3) = 30
    expect(combo!.duracionMinutos).toBe(30);
  });

  it("a un hombre le reserva más tiempo por las mismas zonas", async () => {
    const combo = await obtenerCombo(db, esencialesId, "hombre");
    // 2 grandes (10) + 4 chicas (5) = 40
    expect(combo!.duracionMinutos).toBe(40);
  });

  it("un pack fijo le cobra al hombre proporcional a su tiempo", async () => {
    const mujer = await obtenerCombo(db, esencialesId, "mujer");
    const hombre = await obtenerCombo(db, esencialesId, "hombre");
    expect(mujer!.precioFinal).toBe(49000);
    // 49.000 × 40/30 = 65.333 → redondeo 1000 → 65.000
    expect(hombre!.precioFinal).toBe(65000);
  });

  /**
   * `depilation_pricing_config` es la configuración de precios del salón,
   * fila única: escribirla desde un test y restaurarla en el `afterAll` es
   * un riesgo real, no teórico — el reporte de la Task 2 documenta tests de
   * esta misma rama crasheando a mitad de camino y salteándose su propio
   * cleanup. Un crash en el momento equivocado dejaría a la dueña con la
   * tarifa de hombre cambiada en la base de verdad. Además, hoy
   * `price_male_*` == `price_female_*` en la base local (nadie ajustó
   * todavía los de hombre, la migración 1.56.0 los copió iguales), así que
   * sin diferenciarlos ARTIFICIALMENTE este caso no se puede ejercitar leyendo
   * la config real. Por eso acá NO se toca la base: se arma un
   * `DepilationConfig` a mano, con hombre distinto de mujer, y se llama
   * `assembleDepilationCombo` directo — es una función pura, no necesita la
   * base para nada. Los demás tests de este describe sí van por
   * `obtenerCombo`, porque ésos SÍ tienen que probar el camino completo
   * (leer la fila real, mapearla) con la config que hay hoy.
   */
  it("un combo `guardado` cotiza con la fórmula del sexo que corresponde", () => {
    const config: DepilationConfig = {
      precioLista: {
        mujer: { grande: 19000, mediana: 17000, chica: 12000 },
        hombre: { grande: 23000, mediana: 19500, chica: 15000 },
      },
      minutosPrecio: {
        mujer: { grande: 10, mediana: 7, chica: 5 },
        hombre: { grande: 11, mediana: 9, chica: 8 },
      },
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
    const comboGuardado: DepilationComboRow = {
      id: "guardado-de-prueba",
      name: "Guardado de prueba",
      description: null,
      kind: "guardado",
      fixedPrice: null,
      fixedDurationMinutes: null,
      choiceZoneCount: 0,
      packSessions: null,
      packDiscountPercentage: null,
      packRoundingBase: null,
      validityMonths: null,
      isPublishedWeb: false,
      displayOrder: 0,
      isActive: true,
    };
    const zonas: ZonaParaCotizar[] = [
      { id: "z1", nombre: "Media pierna", categoria: "mediana" },
      { id: "z2", nombre: "Medio brazo", categoria: "mediana" },
    ];

    const mujer = assembleDepilationCombo(comboGuardado, zonas, config, "mujer");
    const hombre = assembleDepilationCombo(comboGuardado, zonas, config, "hombre");
    expect(hombre.precioFinal).toBeGreaterThan(mujer.precioFinal);
  });

  it("sin sexo se comporta como mujer, que es lo de siempre", async () => {
    const sinSexo = await obtenerCombo(db, esencialesId);
    const mujer = await obtenerCombo(db, esencialesId, "mujer");
    expect(sinSexo!.precioFinal).toBe(mujer!.precioFinal);
    expect(sinSexo!.duracionMinutos).toBe(mujer!.duracionMinutos);
  });
});
