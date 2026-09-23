import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { contacts, customers } from "../db/schema";
import type { Db } from "../db/client";
import { sexoDeLaClienta } from "./clientes-sexo.repo";

// `fetch_types: false` a propósito: espeja las opciones de producción bajo
// Hyperdrive, que es donde los arrays como parámetro revientan.
const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
  max: 1,
  fetch_types: false,
  prepare: false,
});
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_SEXO";
let idMujer: string;
let idHombre: string;
let idSinCargar: string;

async function limpiar() {
  const cts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.name, `${QA}%`));
  for (const c of cts) {
    await db.delete(customers).where(eq(customers.contactId, c.id));
    await db.delete(contacts).where(eq(contacts.id, c.id));
  }
}

async function crearClienta(nombre: string, sexo: "mujer" | "hombre" | null): Promise<string> {
  const [ct] = await db.insert(contacts).values({ name: nombre, sexo }).returning({ id: contacts.id });
  const [cu] = await db.insert(customers).values({ contactId: ct!.id }).returning({ id: customers.id });
  return cu!.id;
}

beforeAll(async () => {
  await limpiar();
  idMujer = await crearClienta(`${QA}_MUJER`, "mujer");
  idHombre = await crearClienta(`${QA}_HOMBRE`, "hombre");
  idSinCargar = await crearClienta(`${QA}_SIN_CARGAR`, null);
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("sexoDeLaClienta", () => {
  it("lee el sexo cargado en el contacto", async () => {
    expect(await sexoDeLaClienta(db, idMujer)).toBe("mujer");
    expect(await sexoDeLaClienta(db, idHombre)).toBe("hombre");
  });

  /**
   * NULL = mujer, y no es una elección estética: es el comportamiento que el
   * sistema tuvo siempre (`SEXO_DURACION_CATALOGO = "mujer"`). Si esto tirara
   * error, los miles de contactos que nadie clasificó dejarían de poder
   * comprar.
   */
  it("sin cargar se calcula como mujer", async () => {
    expect(await sexoDeLaClienta(db, idSinCargar)).toBe("mujer");
  });

  it("una clienta que no existe tampoco rompe: mujer", async () => {
    expect(await sexoDeLaClienta(db, "00000000-0000-0000-0000-000000000000")).toBe("mujer");
  });
});
