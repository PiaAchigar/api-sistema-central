import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { gte, sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../db/schema";
import { fechasCrudas } from "./parametros-de-consulta";

/**
 * Un cliente que NUNCA se conecta: `postgres()` es perezoso y `.toSQL()` sólo
 * arma texto y parámetros. Sin base, sin red, sin nada que limpiar después.
 */
const db = drizzle(postgres("postgresql://sin:conexion@127.0.0.1:1/vacio"), { schema });
const ahora = new Date("2026-09-16T01:00:00.000Z");

describe("fechasCrudas", () => {
  /**
   * Este test es el que sostiene a todos los demás. Si `fechasCrudas` dejara
   * de detectar el caso roto, la suite entera seguiría verde sin vigilar nada
   * — el peor resultado posible para una red de seguridad.
   */
  it("agarra el Date que un fragmento sql crudo deja pasar", () => {
    const consulta = db
      .select()
      .from(schema.customerPurchase)
      .where(sql`${schema.customerPurchase.expiresAt} >= ${ahora}`)
      .toSQL();

    expect(fechasCrudas(consulta)).toEqual([{ posicion: 1, valor: ahora }]);
  });

  it("no marca nada cuando la misma fecha entra por un operador de Drizzle", () => {
    const consulta = db
      .select()
      .from(schema.customerPurchase)
      .where(gte(schema.customerPurchase.expiresAt, ahora))
      .toSQL();

    expect(fechasCrudas(consulta)).toEqual([]);
    // Y esto es lo que hace que ande: sale como string, no como Date.
    expect(consulta.params).toEqual(["2026-09-16T01:00:00.000Z"]);
  });

  it("numera como Postgres: el primer parámetro es $1", () => {
    expect(fechasCrudas({ params: ["ok", ahora] })).toEqual([{ posicion: 2, valor: ahora }]);
  });

  it("sin parámetros no encuentra nada", () => {
    expect(fechasCrudas({ params: [] })).toEqual([]);
  });
});
