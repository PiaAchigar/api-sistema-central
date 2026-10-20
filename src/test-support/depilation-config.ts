import { afterAll, beforeAll } from "vitest";
// El proyecto no tiene @types/node (solo workers-types); esto solo corre en vitest, bajo Node.
// @ts-expect-error sin tipos de node
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
// @ts-expect-error sin tipos de node
import { tmpdir } from "node:os";
// @ts-expect-error sin tipos de node
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { depilationPricingConfig } from "../db/schema";
import type { ConfigInput } from "../repositories/depilacion.repo";

/**
 * La configuración de depilación (`depilation_pricing_config`) la edita Laura
 * desde el dashboard cuando quiere: minutos por tamaño de zona y sexo, precios.
 * Los tests que prueban "un hombre necesita más tiempo / paga más que una
 * mujer" no pueden depender de lo que ella tenga cargado ese día (el
 * 2026-10-19 cambió los minutos de turno de mujer 9/6/3 → 10/7/5 y 12 tests
 * se rompieron sin ningún bug).
 *
 * Esta ayuda hace que cada archivo arme SU configuración conocida:
 *   - beforeAll: toma un lock global de Postgres (advisory lock), guarda la
 *     fila real, escribe `CONFIG_DE_TEST` y
 *   - afterAll: restaura la fila real tal cual estaba (siempre, haya pasado
 *     lo que haya pasado en los tests) y suelta el lock.
 *
 * El lock serializa los archivos que usan esta ayuda: vitest corre los
 * archivos en paralelo y la config es una fila única, así que dos archivos
 * pisándose la fila darían fallas intermitentes. Los archivos esperan su
 * turno en el beforeAll.
 *
 * Si un proceso muere a mitad de camino (Ctrl+C, crash) la fila real queda
 * guardada en un archivo de respaldo en el directorio temporal; la próxima
 * corrida la restaura antes de tomar su propia copia.
 */

/** Clave arbitraria pero fija del advisory lock compartido por todos los archivos. */
const LOCK_KEY = 5_620_187;
const RESPALDO = join(tmpdir(), "piubella-depilation-config-respaldo.json");
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";

/**
 * La config conocida de los tests. Los valores son los de la migración 1.35.0
 * / 1.56.0 con las que se escribieron las expectativas:
 *   - Precios de lista (mujer = hombre): grande 19.000, mediana 17.000, chica 12.000.
 *   - Minutos de precio (mujer = hombre): 10 / 7 / 5. Tarifa escalón 1: 1.200, escalón 2: 1.000.
 *   - Minutos de turno MUJER: grande 9, mediana 6, chica 3.
 *   - Minutos de turno HOMBRE: grande 10, mediana 8, chica 5 (más que mujer a propósito).
 *   - Redondeo de turno 5, mínimo 10, pack de 3 sesiones, 15% de descuento, redondeo de pack 1.000.
 */
export const CONFIG_DE_TEST: ConfigInput = {
  priceFemaleGrande: 19000,
  priceFemaleMediana: 17000,
  priceFemaleChica: 12000,
  priceMaleGrande: 19000,
  priceMaleMediana: 17000,
  priceMaleChica: 12000,
  pricingMinutesFemaleGrande: 10,
  pricingMinutesFemaleMediana: 7,
  pricingMinutesFemaleChica: 5,
  pricingMinutesMaleGrande: 10,
  pricingMinutesMaleMediana: 7,
  pricingMinutesMaleChica: 5,
  tier1RatePerMinute: 1200,
  tier2RatePerMinute: 1000,
  slotMinutesFemaleGrande: 9,
  slotMinutesFemaleMediana: 6,
  slotMinutesFemaleChica: 3,
  slotMinutesMaleGrande: 10,
  slotMinutesMaleMediana: 8,
  slotMinutesMaleChica: 5,
  slotRoundingStep: 5,
  slotMinimumMinutes: 10,
  packSessions: 3,
  packDiscountPercentage: 15,
  packRoundingBase: 1000,
};

/**
 * Registrar una vez, a nivel de archivo, antes de cualquier otro hook.
 * Para leer la config de test dentro de un test, usar `CONFIG_DE_TEST`.
 */
export function usarConfigDeDepilacionDeTest(): void {
  const sql = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
  const db = drizzle(sql, { schema });
  let original: typeof depilationPricingConfig.$inferSelect | null = null;
  let tieneLock = false;

  async function restaurar(fila: typeof depilationPricingConfig.$inferSelect) {
    await db.update(depilationPricingConfig).set(fila).where(eq(depilationPricingConfig.id, fila.id));
  }

  beforeAll(async () => {
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    tieneLock = true;

    // Una corrida anterior murió sin restaurar: su respaldo es la verdad.
    if (existsSync(RESPALDO)) {
      const previa = JSON.parse(readFileSync(RESPALDO, "utf8")) as typeof depilationPricingConfig.$inferSelect;
      await restaurar({ ...previa, updatedAt: new Date(previa.updatedAt) });
      unlinkSync(RESPALDO);
    }

    const [fila] = await db.select().from(depilationPricingConfig).limit(1);
    if (!fila) throw new Error("Falta la fila de depilation_pricing_config");
    original = fila;
    writeFileSync(RESPALDO, JSON.stringify(fila));

    await db
      .update(depilationPricingConfig)
      .set({ ...CONFIG_DE_TEST })
      .where(eq(depilationPricingConfig.id, fila.id));
  }, 300_000);

  afterAll(async () => {
    try {
      if (original) {
        await restaurar(original);
        if (existsSync(RESPALDO)) unlinkSync(RESPALDO);
      }
    } finally {
      if (tieneLock) await sql`select pg_advisory_unlock(${LOCK_KEY})`;
      await sql.end();
    }
  }, 60_000);
}
