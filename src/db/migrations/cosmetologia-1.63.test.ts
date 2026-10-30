import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
// @ts-ignore -- el proyecto no incluye @types/node (solo workers-types); vitest corre en Node
import { execSync } from "node:child_process";

/**
 * Migración 1.63.0: Cosmetología como categoría propia y las categorías que
 * faltaban según CATEGORIAS.md de Laura (pedido del 2026-10-28, #32).
 *
 * Es una migración de DATOS sobre el catálogo real: sólo corre si la base
 * local lo tiene (`./scripts/traer-catalogo.sh`). Con el catálogo de juguete
 * del seed no hay nada que migrar y se saltea.
 */
const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const sql = postgres(URL_DB, { max: 1, fetch_types: false, prepare: false });
const ARCHIVO = "src/db/migrations/1.63.0/01-cosmetologia-y-categorias-faltantes.sql";

function aplicarMigracion() {
  execSync(
    `DOCKER_CONTEXT=default docker exec -i piubella-db psql -U piubella -d piubella -v ON_ERROR_STOP=1 < "${ARCHIVO}"`,
    { stdio: "pipe" },
  );
}

const [catalogoReal] = await sql<{ hay: boolean }[]>`
  SELECT EXISTS (SELECT 1 FROM categories WHERE name IN ('Tratamientos Cosmetológicos', 'Cosmetología Facial')) AS hay`;
const hay = catalogoReal?.hay ?? false;

async function padreDe(nombre: string): Promise<string | null> {
  const rows = await sql<{ padre: string | null }[]>`
    SELECT p.name AS padre FROM categories c
    LEFT JOIN categories p ON p.id = c.parent_category_id
    WHERE c.name = ${nombre} AND c.kind <> 'area'`;
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

/** Servicios que sólo tienen su área: no aparecen en el menú de la web. */
async function fueraDelMenu(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT s.name FROM service s
    WHERE NOT EXISTS (
      SELECT 1 FROM service_category sc JOIN categories c ON c.id = sc.category_id
      WHERE sc.service_id = s.id AND c.kind <> 'area')
    ORDER BY 1`;
  return rows.map((r) => r.name);
}

describe.skipIf(!hay)("migración 1.63.0 — Cosmetología y categorías faltantes", () => {
  let antes = 0;
  let huerfanosAntes: string[] = [];

  beforeAll(async () => {
    huerfanosAntes = await fueraDelMenu();
    aplicarMigracion();
    antes = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM categories`)[0]!.n;
  });

  afterAll(() => sql.end());

  it("Cosmetología es una categoría principal, con Facial y Corporal", async () => {
    expect(await padreDe("Cosmetología")).toBeNull();
    expect(await padreDe("Cosmetología Facial")).toBe("Cosmetología");
    expect(await padreDe("Cosmetología Corporal")).toBe("Cosmetología");
  });

  it("Tratamientos Faciales deja de existir: sus hijas pasan a Cosmetología Facial", async () => {
    expect(await sql`SELECT 1 FROM categories WHERE name = 'Tratamientos Faciales'`).toHaveLength(0);
    // "Tratamientos Cosmetológicos" ES Cosmetología Facial, con otro nombre y otro padre.
    expect(await sql`SELECT 1 FROM categories WHERE name = 'Tratamientos Cosmetológicos'`).toHaveLength(0);
    for (const hoja of [
      "Limpieza de cutis", "Dermaplaning", "Peeling", "Hidratación de Labios",
      "Rejuvenecimiento Facial", "Manchas", "Acné y marcas de acné", "Ojeras", "Rosácea",
      "Dermapen Tratamiento Facial", "Rutina de cuidado facial",
    ])
      expect(await padreDe(hoja)).toBe("Cosmetología Facial");
  });

  it("los servicios que colgaban directo de Tratamientos Faciales pasan a Cosmetología Facial", async () => {
    for (const s of ["HIFU Facial con Papada - Sesión", "IPL Rostro - Sesión", "Crio-Radiofrecuencia - 1 zona",
                     "Limpieza de Cutis Profunda", "Hidratación de Labios"])
      expect(await categoriasDe(s)).toContain("Cosmetología Facial");
    // Y siguen en la aparatología.
    expect(await categoriasDe("HIFU Facial con Papada - Sesión")).toContain("Aparatología Cosmetológica");
  });

  it("se borran las Facial/Corporal desactivadas que repetían servicios", async () => {
    for (const vieja of ["Aparatología Facial", "Peeling y Dermaplaning", "Tratamientos Faciales por Sesiones"])
      expect(await sql`SELECT 1 FROM categories WHERE name = ${vieja}`).toHaveLength(0);
    expect(
      await sql`SELECT c.name FROM categories c JOIN categories p ON p.id = c.parent_category_id
                 WHERE p.name = 'Cosmetología Facial' AND c.name IN ('Facial', 'Corporal')`,
    ).toHaveLength(0);
    // Los tratamientos por sesiones siguen en su objetivo.
    expect(await categoriasDe("Tratamiento de Acné Juvenil - 4 Sesiones")).toContain("Acné y marcas de acné");
    expect(await categoriasDe("Tratamiento de Rosácea - 4 Sesiones")).toContain("Rosácea");
  });

  it("Cosmetología Facial no tiene un \"Acné\" repetido", async () => {
    expect(await sql`SELECT 1 FROM categories WHERE name = 'Acné'`).toHaveLength(0);
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
    ["Cosmetología Facial", ["Cicatrices", "Arrugas - Flaccidez", "Piel seca", "Piel grasa", "Quistes de milium"]],
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

  it("Dermatología es raíz y Tratamientos Médicos ya no existe", async () => {
    expect(await padreDe("Dermatología")).toBeNull();
    expect(await sql`SELECT 1 FROM categories WHERE name = 'Tratamientos Médicos'`).toHaveLength(0);
    for (const hija of ["Dermatología Clínica", "Dermatología Estética", "Medicina Regenerativa",
                        "Medicina Terapéutica", "Cirugía Dermatológica"])
      expect(await padreDe(hija)).toBe("Dermatología");
    // Lo que colgaba directo de Tratamientos Médicos sigue en Dermatología.
    expect(await categoriasDe("Biopsia con Extracción y Estudio Patológico")).toContain("Dermatología");
  });

  it("Depilación Definitiva, Actividades y Capacitaciones tienen categoría, además de su área", async () => {
    const raices = await sql<{ name: string; kind: string }[]>`
      SELECT name, kind FROM categories
       WHERE name IN ('Depilación Definitiva', 'Actividades', 'Capacitaciones') AND parent_category_id IS NULL
       ORDER BY name, kind`;
    expect(raices.map((r) => `${r.name}/${r.kind}`)).toEqual([
      "Actividades/area", "Actividades/tecnica",
      "Capacitaciones/area", "Capacitaciones/tecnica",
      "Depilación Definitiva/area", "Depilación Definitiva/tecnica",
    ]);
    const hijas = await sql<{ padre: string; name: string }[]>`
      SELECT p.name AS padre, c.name FROM categories c JOIN categories p ON p.id = c.parent_category_id
       WHERE p.name IN ('Depilación Definitiva', 'Actividades') AND p.kind <> 'area' ORDER BY 1, 2`;
    expect(hijas.map((h) => `${h.padre} > ${h.name}`)).toEqual([
      "Actividades > Pilates Power 360", "Actividades > Pilates Reformer", "Actividades > Thermobike",
      "Depilación Definitiva > Crystal 3D Plus",
      "Depilación Definitiva > Depilación Definitiva Corporal", "Depilación Definitiva > Depilación Definitiva Facial",
    ]);
    // Las áreas quedan sin hijas: son sólo las pestañas.
    expect(await sql`
      SELECT 1 FROM categories c JOIN categories p ON p.id = c.parent_category_id
       WHERE p.kind = 'area' AND p.name IN ('Depilación Definitiva', 'Actividades')`).toHaveLength(0);
  });

  it("las raíces quedan en el orden de CATEGORIAS.md", async () => {
    const raices = await sql<{ name: string }[]>`
      SELECT name FROM categories
       WHERE parent_category_id IS NULL AND kind <> 'area' AND is_active
       ORDER BY display_order, name`;
    expect(raices.map((r) => r.name).slice(0, 10)).toEqual([
      "Actividades", "Estética Corporal", "Cosmetología", "Depilación Definitiva", "Belleza",
      "Masajes", "Manicuría y Pedicuría", "Dermatología", "Capacitaciones", "Aparatología",
    ]);
  });

  it("ningún servicio queda fuera del menú por esta migración", async () => {
    // Los que ya estaban sólo en su área antes (p. ej. "Masaje - HOMBRE -
    // espalda") no son de acá: quedan anotados para Laura.
    expect(await fueraDelMenu()).toEqual(huerfanosAntes);
  });

  it("correrla dos veces no duplica nada", async () => {
    aplicarMigracion();
    const n = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM categories`)[0]!.n;
    expect(n).toBe(antes);
    const links = (await sql<{ links: number }[]>`
      SELECT count(*)::int AS links FROM (
        SELECT service_id, category_id FROM service_category GROUP BY 1, 2 HAVING count(*) > 1) d`)[0]!.links;
    expect(links).toBe(0);
  });
});
