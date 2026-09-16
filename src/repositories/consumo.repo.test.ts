import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema";
import { fechasCrudas } from "../lib/parametros-de-consulta";
import { condicionDeServicioLibre } from "./consumo.repo";

/**
 * Las consultas que se revisan de cerca antes de que salgan a producción.
 *
 * Acá ningún test toca una base —es la regla de la casa— así que una consulta
 * mal parametrizada pasaría verde y rompería recién contra Postgres. Esta
 * lista es la red: sumar una consulta es agregarle una entrada.
 *
 * El porqué de "ningún Date" está en `lib/parametros-de-consulta.ts`.
 */
const db = drizzle(postgres("postgresql://sin:conexion@127.0.0.1:1/vacio"), { schema });

const CONSULTAS: Record<string, () => { params: readonly unknown[] }> = {
  "qué tiene la clienta a favor para este servicio": () =>
    db
      .select()
      .from(schema.customerPurchaseService)
      .where(
        condicionDeServicioLibre(
          "11111111-1111-1111-1111-111111111111",
          "22222222-2222-2222-2222-222222222222",
          new Date("2026-09-16T01:00:00.000Z"),
        ),
      )
      .toSQL(),
};

describe("ningún parámetro sale como Date", () => {
  for (const [nombre, armar] of Object.entries(CONSULTAS)) {
    it(nombre, () => {
      expect(fechasCrudas(armar())).toEqual([]);
    });
  }
});
