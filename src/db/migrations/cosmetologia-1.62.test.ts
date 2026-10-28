import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
// @ts-ignore -- el proyecto no incluye @types/node (solo workers-types); vitest corre en Node
import { execSync } from "node:child_process";

/**
 * Migración 1.62.0: Cosmetología como categoría propia y las categorías que
 * faltaban según CATEGORIAS.md de Laura (pedido del 2026-10-28, #32).
 *
 * Es una migración de DATOS sobre el catálogo real: sólo corre si la base
 * local lo tiene (`./scripts/traer-catalogo.sh`). Con el catálogo de juguete
 * del seed no hay nada que migrar y se saltea.
 */
const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const sql = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const ARCHIVO = "src/db/migrations/1.62.0/01-cosmetologia-y-categorias-faltantes.sql";

function aplicarMigracion() {
  execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${ARCHIVO}"`,
    { stdio: "pipe" },
  );
}

const [{ hay }] = await sql<{ hay: boolean }[]>`
  SELECT EXISTS (SELECT 1 FROM categories WHERE name IN ('Tratamientos Cosmetológicos', 'Cosmetología Facial')) AS hay`;

async function padreDe(nombre: string): Promise<string | null> {
  const rows = await sql<{ padre: string | null }[]>`
    SELECT p.name AS padre FROM categories c
    LEFT JOIN categories p ON p.id = c.parent_category_id
    WHERE c.name = ${nombre}`;
  expect(rows, `"${nombre}" tiene que existir una sola vez`).toHaveLength(1);
  return rows[0]!.padre;
}

async function categoriasDe(servicio: string): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT c.name FROM service s
    JOIN service_category sc ON sc.service_id = s.id
    JOIN categories c ON c.id = sc.category_id
    WHERE s.name = ${servicio}`;
  return rows.map((r) => r.name);
}

describe.skipIf(!hay)("migración 1.62.0 — Cosmetología y categorías faltantes", () => {
  let antes = 0;

  beforeAll(async () => {
    aplicarMigracion();
    [{ n: antes }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM categories`;
  });

  afterAll(() => sql.end());

  it("Cosmetología es una categoría principal, con Facial y Corporal", async () => {
    expect(await padreDe("Cosmetología")).toBeNull();
    expect(await padreDe("Cosmetología Facial")).toBe("Cosmetología");
    expect(await padreDe("Cosmetología Corporal")).toBe("Cosmetología");
  });

  it("lo de la cosmetóloga pasa a Cosmetología Facial; Tratamientos Faciales queda con la aparatología", async () => {
    // "Tratamientos Cosmetológicos" ES Cosmetología Facial, con otro nombre y otro padre.
    expect(await sql`SELECT 1 FROM categories WHERE name = 'Tratamientos Cosmetológicos'`).toHaveLength(0);
    for (const hoja of ["Limpieza de cutis", "Dermaplaning", "Peeling", "Hidratación de Labios"])
      expect(await padreDe(hoja)).toBe("Cosmetología Facial");
    for (const hoja of ["Rejuvenecimiento Facial", "Manchas", "Ojeras", "Rosácea"])
      expect(await padreDe(hoja)).toBe("Tratamientos Faciales");
  });

  it("HIFU e IPL salen de Cosmetología, pero siguen en Tratamientos Faciales y Aparatología", async () => {
    for (const s of ["HIFU Facial con Papada - Sesión", "IPL Rostro - Sesión"]) {
      const cats = await categoriasDe(s);
      expect(cats).not.toContain("Cosmetología Facial");
      expect(cats).toContain("Rejuvenecimiento Facial");
      expect(cats).toContain("Aparatología Cosmetológica");
    }
  });

  it("la limpieza de espalda pasa de Estética Corporal a Cosmetología Corporal (pedido de Laura)", async () => {
    for (const s of ["Limpieza de Espalda", "Limpieza de Espalda con Peeling"]) {
      const cats = await categoriasDe(s);
      expect(cats).toContain("Acné corporal");
      expect(cats).not.toContain("Estética Corporal");
      expect(cats).not.toContain("Cosmetología Facial");
      // Los objetivos de la cara no son de la espalda.
      expect(cats).not.toContain("Manchas");
      expect(cats).not.toContain("Acné y marcas de acné");
      // El área no se toca.
      expect(cats).toContain("Estética");
    }
    const gluteos = await categoriasDe("Limpieza de Glúteos con Peeling");
    expect(gluteos).toContain("Cosmetología Corporal");
    expect(gluteos).not.toContain("Estética Corporal");
  });

  it.each([
    ["Cosmetología Facial", ["Acné", "Cicatrices", "Arrugas - Flaccidez", "Piel seca", "Piel grasa", "Quistes de milium"]],
    ["Cosmetología Corporal", ["Estrías (cosmetología)", "Acné corporal", "Cicatrices de acné corporal", "Celulitis (cosmetología)"]],
    ["Masajes", ["Masajes Reductores", "Drenaje Post Quirúrgico"]],
    ["Dermatología Clínica", ["Dermatoscopia"]],
    ["Infecciones de la piel", ["Herpes"]],
    ["Enfermedades inflamatorias y crónicas", ["Dermatosis"]],
    ["Bioestimuladores", ["Profhilo Structura", "Harmonyca"]],
    ["Arrugas y Flaccidez", ["Exosomas y factores de crecimiento"]],
    ["Contorno de ojos y párpados", ["Mesoterapia y peeling para ojeras", "Blefaroplastia no quirúrgica"]],
    ["Tratamiento Capilar", ["PRP capilar", "Mesoterapia capilar", "Exosomas capilares", "PDRN+"]],
    ["Glúteos", ["Alidya"]],
  ])("bajo %s se suman las que faltaban", async (padre, hojas) => {
    for (const hoja of hojas) expect(await padreDe(hoja)).toBe(padre);
  });

  it("Alisado de cejas pasa a llamarse como lo nombra Laura", async () => {
    expect(await padreDe("Laminado y alisado de cejas")).toBe("Belleza");
  });

  it("los servicios que ya existían quedan en su categoría nueva", async () => {
    expect(await categoriasDe("DRENAJE LINFÁTICO POST QUIRÚRGICO CON ULTRASONIDO")).toContain(
      "Drenaje Post Quirúrgico",
    );
    expect(await categoriasDe("Dermatoscopia - Control de Lunares")).toContain("Dermatoscopia");
    expect(await categoriasDe("Alidya -  1 Zona")).toContain("Alidya");
  });

  it("las categorías nuevas están activas", async () => {
    expect(
      await sql`SELECT name FROM categories WHERE name IN ('Cosmetología', 'Acné corporal', 'PDRN+') AND is_active IS NOT TRUE`,
    ).toHaveLength(0);
  });

  it("ningún servicio que se tocó queda sin categoría de catálogo (o sea, fuera del menú)", async () => {
    // Masaje - HOMBRE - espalda ya estaba sólo en su área antes de esta
    // migración: no es de acá, queda anotado para Laura.
    const huerfanos = await sql`
      SELECT s.name FROM service s
      WHERE (s.name ILIKE 'HIFU%' OR s.name ILIKE 'IPL%' OR s.name ILIKE 'Limpieza de%')
        AND NOT EXISTS (
          SELECT 1 FROM service_category sc JOIN categories c ON c.id = sc.category_id
          WHERE sc.service_id = s.id AND c.kind <> 'area')`;
    expect(huerfanos).toHaveLength(0);
  });

  it("correrla dos veces no duplica nada", async () => {
    aplicarMigracion();
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM categories`;
    expect(n).toBe(antes);
    const [{ links }] = await sql<{ links: number }[]>`
      SELECT count(*)::int AS links FROM (
        SELECT service_id, category_id FROM service_category GROUP BY 1, 2 HAVING count(*) > 1) d`;
    expect(links).toBe(0);
  });
});
