import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like, notLike } from "drizzle-orm";
import * as schema from "../db/schema";
import { bodyZone, depilationPricingConfig } from "../db/schema";
import type { Db } from "../db/client";
import { crearCombo, hardDeleteCombo, obtenerCombo } from "./depilacion.repo";

/**
 * Task 4 (1.56.0): `obtenerCombo`/`assembleDepilationCombo` conectados con la
 * config real por sexo. Integración contra Postgres local — el mapeo
 * `aConfigAnidada` (columnas `female`/`male` de la base → `mujer`/`hombre`
 * del tipo) es justamente lo que un doble de `Db` no puede probar: hay que
 * leer la fila real.
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
let guardadoId = "";
// Fila completa de antes, para restaurar exactamente en el afterAll.
let filaConfigAntes: typeof depilationPricingConfig.$inferSelect | undefined;

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
  const medianaA = idDeZonaReal("Media pierna");
  const medianaB = idDeZonaReal("Medio brazo");

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

  // Un `guardado` de 2 zonas "mediana": sin `fixed_price`, cotiza con la
  // fórmula — el caso que prueba que el sexo llega hasta `calcularPrecioCombo`.
  const guardado = await crearCombo(db, {
    name: `${QA}_GUARDADO`,
    kind: "guardado",
    zonaIds: [medianaA, medianaB],
  });
  guardadoId = guardado!.id;

  // La config real de hoy tiene `price_male_*` == `price_female_*`: la
  // migración 1.56.0 copió los valores de mujer a las dos familias de
  // columnas y nadie ajustó todavía los de hombre (ver el comentario de
  // `DepilationConfig.precioLista` en depilation-pricing.ts). Sin
  // diferenciarlos, un `guardado` cotizaría EXACTAMENTE igual para los dos
  // sexos — no porque el mapeo `female`→`mujer`/`male`→`hombre` esté mal,
  // sino porque no hay ningún número distinto que leer, y el test de abajo
  // ("cotiza con la fórmula del sexo que corresponde") no podría probar nada.
  //
  // Se diferencia acá SOLO la columna "mediana" (la única categoría que usa
  // `guardadoId`) y SOLO por la duración de este archivo: se restaura en el
  // afterAll. "Grande"/"chica" quedan intactas — otras suites (`GET /combos`,
  // `POST /cotizar` con zonas grande/chica) siguen leyendo los valores reales
  // de la migración 1.35.0 sin verse afectadas.
  [filaConfigAntes] = await db.select().from(depilationPricingConfig).limit(1);
  if (!filaConfigAntes) throw new Error("falta la fila de depilation_pricing_config");
  await db
    .update(depilationPricingConfig)
    .set({ priceMaleMediana: 19000, pricingMinutesMaleMediana: 9 })
    .where(eq(depilationPricingConfig.singleton, true));
});

afterAll(async () => {
  if (filaConfigAntes) {
    await db
      .update(depilationPricingConfig)
      .set({
        priceMaleMediana: filaConfigAntes.priceMaleMediana,
        pricingMinutesMaleMediana: filaConfigAntes.pricingMinutesMaleMediana,
      })
      .where(eq(depilationPricingConfig.singleton, true));
  }
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

  it("un combo `guardado` cotiza con la fórmula del sexo que corresponde", async () => {
    const mujer = await obtenerCombo(db, guardadoId, "mujer");
    const hombre = await obtenerCombo(db, guardadoId, "hombre");
    expect(hombre!.precioFinal).toBeGreaterThan(mujer!.precioFinal);
  });

  it("sin sexo se comporta como mujer, que es lo de siempre", async () => {
    const sinSexo = await obtenerCombo(db, esencialesId);
    const mujer = await obtenerCombo(db, esencialesId, "mujer");
    expect(sinSexo!.precioFinal).toBe(mujer!.precioFinal);
    expect(sinSexo!.duracionMinutos).toBe(mujer!.duracionMinutos);
  });
});
