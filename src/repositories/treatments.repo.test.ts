import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { like, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { service } from "../db/schema";
import type { Db } from "../db/client";
import { priceLabelFor, searchTreatments } from "./treatments.repo";

describe("priceLabelFor", () => {
  it("un servicio se cobra por sesión", () => {
    expect(priceLabelFor("service", "Criolipólisis - 1 zona")).toBe("por sesión");
  });

  it("una capacitación se cobra por el curso entero", () => {
    expect(priceLabelFor("training", "Instructorado de Pilates Reformer")).toBe("el curso");
  });

  it("un abono de actividad se cobra por mes", () => {
    expect(priceLabelFor("activity", "Pilates Reformer - Abono mensual 1 vez por semana")).toBe("por mes");
  });

  it("una clase suelta NO se cobra por mes", () => {
    expect(priceLabelFor("activity", "Pilates Reformer - Clase suelta/prueba")).toBe("por clase");
    expect(priceLabelFor("activity", "Thermobike - Clase suelta/prueba")).toBe("por clase");
  });
});

/**
 * Ronda de arreglos 1 (Task 9, concern de la coordinadora): la rama `service`
 * del UNION ALL de `searchTreatments` filtraba sólo por `is_active`, sin
 * `no_vendible`. Ese SELECT alimenta `POST /api/treatments/search`, el
 * buscador PÚBLICO SIN AUTH del home de `piubella_web` — el mismo tipo de
 * catálogo que esta tarea existe para blindar, y se había escapado del
 * rastreo original porque no es un simple `listServices`/`listCatalogoVendible`
 * sino SQL crudo con embeddings.
 *
 * Probar el buscador de punta a punta con un embedding REAL sería caro (pega
 * a una API externa). En cambio, se ejercita la condición del WHERE tal cual
 * corre en producción: dos servicios fixture con el MISMO vector cargado a
 * mano en `service_embeddings` (bypaseando la API), uno con `no_vendible:
 * true` y otro con `no_vendible: false`. Al buscar con ESE mismo vector la
 * similitud es 1.0 para los dos —el máximo posible—, así que si el filtro
 * fallara el primero aparecería igual que el segundo.
 */
describe("searchTreatments — el ancla de depilación no aparece en el buscador público", () => {
  const pgClient = postgres("postgresql://piubella:piubella@localhost:5499/piubella", {
    max: 1,
    fetch_types: false,
    prepare: false,
  });
  const db = drizzle(pgClient, { schema }) as unknown as Db;

  const QA = "ZZ_QA_TREATMENTS_SEARCH";
  // Vector constante: no importa que no sea semánticamente real, sólo que
  // sea EL MISMO para los dos fixtures, así los dos miden la máxima
  // similitud posible (1.0) contra la misma query.
  const EMBEDDING = Array(1536).fill(0.05);
  const VECTOR_LITERAL = `[${EMBEDDING.join(",")}]`;

  let anclaId: string;
  let normalId: string;

  async function limpiar() {
    // Cascada: borrar el `service` se lleva puesta su fila de
    // `service_embeddings` (ON DELETE CASCADE, 1.4.0/1.17.0).
    await db.delete(service).where(like(service.name, `${QA}%`));
  }

  beforeAll(async () => {
    await limpiar();

    const [ancla] = await db
      .insert(service)
      .values({ name: `${QA}_ANCLA`, isActive: true, noVendible: true })
      .returning({ id: service.id });
    anclaId = ancla!.id;

    const [normal] = await db
      .insert(service)
      .values({ name: `${QA}_NORMAL`, isActive: true, noVendible: false })
      .returning({ id: service.id });
    normalId = normal!.id;

    // Local NO dispara ningún trigger de sync (no existe en esta base;
    // `service_embeddings` arranca vacía): se inserta la fila a mano, sin
    // pasar por la API de embeddings.
    await db.execute(
      sql`INSERT INTO service_embeddings (service_id, embedding)
          VALUES (${anclaId}, ${VECTOR_LITERAL}::vector), (${normalId}, ${VECTOR_LITERAL}::vector)`,
    );
  });

  afterAll(async () => {
    await limpiar();
    await pgClient.end();
  });

  it("NO incluye al ancla (no_vendible = true) aunque matchee perfecto", async () => {
    const { treatments } = await searchTreatments(db, EMBEDDING, { threshold: 0, limit: 100 });
    expect(treatments.find((t) => t.id === anclaId)).toBeUndefined();
  });

  it("sí incluye a un servicio normal (no_vendible = false) con el mismo match", async () => {
    const { treatments } = await searchTreatments(db, EMBEDDING, { threshold: 0, limit: 100 });
    expect(treatments.find((t) => t.id === normalId)).toBeDefined();
  });
});
