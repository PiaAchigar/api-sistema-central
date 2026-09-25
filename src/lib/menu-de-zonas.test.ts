import { describe, expect, it } from "vitest";
import type { DepilationConfig, ZonaParaCotizar } from "./depilation-pricing";
import { armarMenu, minutosElegidos, regalosElegidos } from "./menu-de-zonas";

const CONFIG: DepilationConfig = {
  precioLista: {
    mujer:  { grande: 19000, mediana: 17000, chica: 12000 },
    hombre: { grande: 23000, mediana: 22000, chica: 19000 },
  },
  minutosPrecio: {
    mujer:  { grande: 10, mediana: 7, chica: 5 },
    hombre: { grande: 11, mediana: 9, chica: 8 },
  },
  tarifaEscalon1: 1200,
  tarifaEscalon2: 1000,
  minutosTurno: {
    mujer:  { grande: 9,  mediana: 6, chica: 3 },
    hombre: { grande: 10, mediana: 8, chica: 5 },
  },
  redondeoTurno: 5,
  turnoMinimo: 10,
  packSesiones: 3,
  packDescuentoPct: 15,
  packRedondeo: 1000,
};

const z = (id: string, categoria: ZonaParaCotizar["categoria"], activa = true) => ({
  id, nombre: id, categoria, activa,
});

const CATALOGO = [
  z("pierna", "grande"), z("espalda", "grande"),
  z("abdomen", "mediana"),
  z("axila", "chica"), z("bozo", "chica"), z("cavado", "chica"),
];

describe("armarMenu", () => {
  it("ofrece las zonas del pack con sus minutos del sexo que corresponde", () => {
    const pack = [z("pierna", "grande"), z("axila", "chica")];
    const mujer = armarMenu(pack, CATALOGO, 0, "mujer", CONFIG);
    expect(mujer.map((x) => [x.nombre, x.minutos])).toEqual([["pierna", 9], ["axila", 3]]);

    const hombre = armarMenu(pack, CATALOGO, 0, "hombre", CONFIG);
    expect(hombre.map((x) => [x.nombre, x.minutos])).toEqual([["pierna", 10], ["axila", 5]]);
  });

  /**
   * Review Focus #3. La zona de regalo se presupuestó como CHICA
   * (`CATEGORIA_ELECCION`), así que sólo se puede gastar en una chica. Si el
   * menú ofreciera "Pierna entera" de regalo, el turno quedaría corto 6
   * minutos y el atraso se acumularía sin que nadie lo vea.
   */
  it("con zona de regalo, ofrece del catálogo SÓLO las chicas que no están en el pack", () => {
    const pack = [z("pierna", "grande"), z("espalda", "grande")];
    const menu = armarMenu(pack, CATALOGO, 1, "mujer", CONFIG);

    const regalo = menu.filter((x) => x.esDeRegalo);
    expect(regalo.map((x) => x.nombre).sort()).toEqual(["axila", "bozo", "cavado"]);
    expect(regalo.every((x) => x.minutos === 3)).toBe(true);
    expect(menu.find((x) => x.nombre === "abdomen")).toBeUndefined();
  });

  it("sin zonas de regalo no ofrece nada del catálogo", () => {
    const menu = armarMenu([z("pierna", "grande")], CATALOGO, 0, "mujer", CONFIG);
    expect(menu.every((x) => !x.esDeRegalo)).toBe(true);
    expect(menu).toHaveLength(1);
  });

  /**
   * Review Focus #2. Una zona archivada después de la venta: la clienta la
   * pagó, así que sigue pesando en el presupuesto, pero no se puede agendar
   * hoy. Ofrecerla sin decir nada la haría elegir algo que después no se
   * presta; esconderla le haría creer que el pack trae menos.
   */
  it("una zona del pack archivada se muestra, deshabilitada y con el motivo", () => {
    const pack = [z("pierna", "grande"), z("bozo", "chica", false)];
    const menu = armarMenu(pack, CATALOGO, 0, "mujer", CONFIG);
    const archivada = menu.find((x) => x.nombre === "bozo")!;
    expect(archivada.disponible).toBe(false);
    expect(archivada.motivo).toMatch(/ya no está/i);
    // Pero sus minutos siguen contando: se pagaron.
    expect(archivada.minutos).toBe(3);
  });
});

describe("minutosElegidos", () => {
  it("suma los minutos de lo tildado", () => {
    const menu = armarMenu(
      [z("pierna", "grande"), z("axila", "chica")], CATALOGO, 0, "mujer", CONFIG,
    );
    expect(minutosElegidos(menu, ["pierna"])).toBe(9);
    expect(minutosElegidos(menu, ["pierna", "axila"])).toBe(12);
    expect(minutosElegidos(menu, [])).toBe(0);
  });

  it("ignora ids que no están en el menú, en vez de sumar NaN", () => {
    const menu = armarMenu([z("pierna", "grande")], CATALOGO, 0, "mujer", CONFIG);
    expect(minutosElegidos(menu, ["pierna", "inventada"])).toBe(9);
  });
});

/**
 * Ronda de arreglos 3 (Minor 3). El spec §7.2 dice "hasta N zonas a
 * elección" y ese tope no lo aplicaba nadie: `armarMenu` ofrece TODAS las
 * chicas activas y el servidor sólo miraba el presupuesto de minutos. Contar
 * cuántas de las tildadas salen del cupo es lo que le falta al servidor para
 * poder decir que no.
 */
describe("regalosElegidos", () => {
  const PACK = [z("pierna", "grande"), z("espalda", "grande")];

  it("cuenta sólo las que salen del cupo, no las que el pack trae", () => {
    const menu = armarMenu(PACK, CATALOGO, 1, "mujer", CONFIG);
    expect(regalosElegidos(menu, ["pierna", "espalda"])).toBe(0);
    expect(regalosElegidos(menu, ["pierna", "axila"])).toBe(1);
    expect(regalosElegidos(menu, ["pierna", "axila", "bozo", "cavado"])).toBe(3);
  });

  it("sin cupo no hay zonas de regalo que contar", () => {
    const menu = armarMenu(PACK, CATALOGO, 0, "mujer", CONFIG);
    expect(regalosElegidos(menu, ["pierna", "espalda"])).toBe(0);
  });

  it("ignora ids que no están en el menú", () => {
    const menu = armarMenu(PACK, CATALOGO, 1, "mujer", CONFIG);
    expect(regalosElegidos(menu, ["inventada"])).toBe(0);
  });
});
