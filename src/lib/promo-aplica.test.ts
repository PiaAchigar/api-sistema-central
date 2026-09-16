import { describe, expect, it } from "vitest";
import { promoAplica, promosQueAplican, tipoDeOrigen, type DestinoDePromo } from "./promo-aplica";

const COMBO_FACIAL = "combo-facial";
const BABY_BOTOX = "svc-baby-botox";
const CUERPO_FULL = "depi-cuerpo-full";

const destinos: DestinoDePromo[] = [
  { tipo: "combo", id: COMBO_FACIAL },
  { tipo: "servicio", id: BABY_BOTOX },
];

describe("tipoDeOrigen", () => {
  it("un pack llega como 'combo': comparten origen en el catálogo", () => {
    // Un pack ES una fila de `combos`. La diferencia está en los datos de esa
    // fila, no en a qué tabla pertenece.
    expect(tipoDeOrigen("combo")).toBe("combo");
  });

  it("depilación tiene su propio tipo", () => {
    expect(tipoDeOrigen("depilacion")).toBe("depilacion");
  });

  it("una capacitación no admite promo", () => {
    // No hay columna de target para capacitaciones y Pia no las pidió.
    expect(tipoDeOrigen("capacitacion")).toBeNull();
  });

  it("un origen desconocido no admite promo", () => {
    expect(tipoDeOrigen("lo-que-sea")).toBeNull();
  });
});

describe("promoAplica", () => {
  it("aplica al combo que está en la lista", () => {
    expect(promoAplica(destinos, { origen: "combo", id: COMBO_FACIAL })).toBe(true);
  });

  it("aplica al servicio suelto que está en la lista", () => {
    expect(promoAplica(destinos, { origen: "servicio", id: BABY_BOTOX })).toBe(true);
  });

  it("NO aplica a un combo que no está en la lista", () => {
    // El bug que esto arregla: hoy el desplegable ofrece TODAS las promos y se
    // le puede aplicar a un Baby Botox una promo pensada para depilación.
    expect(promoAplica(destinos, { origen: "combo", id: "otro-combo" })).toBe(false);
  });

  it("NO confunde un servicio con un combo del mismo id", () => {
    // Los ids son uuid de tablas distintas: podrían coincidir y el tipo es lo
    // único que los separa.
    expect(promoAplica([{ tipo: "combo", id: BABY_BOTOX }], { origen: "servicio", id: BABY_BOTOX }))
      .toBe(false);
  });

  it("NO aplica a una capacitación aunque su id esté en la lista", () => {
    expect(promoAplica([{ tipo: "servicio", id: "cap-1" }], { origen: "capacitacion", id: "cap-1" }))
      .toBe(false);
  });

  it("una promo sin destinos no aplica a nada", () => {
    // Una promo sin destinos no significa "aplica a todo": significa que Laura
    // se olvidó de marcar algo.
    expect(promoAplica([], { origen: "combo", id: COMBO_FACIAL })).toBe(false);
  });

  it("aplica a un combo de depilación", () => {
    expect(promoAplica([{ tipo: "depilacion", id: CUERPO_FULL }], { origen: "depilacion", id: CUERPO_FULL }))
      .toBe(true);
  });
});

describe("promosQueAplican", () => {
  const promos = [
    { id: "p1", destinos: [{ tipo: "combo", id: COMBO_FACIAL }] as DestinoDePromo[] },
    { id: "p2", destinos: [{ tipo: "servicio", id: BABY_BOTOX }] as DestinoDePromo[] },
  ];

  it("deja sólo las que sirven para lo elegido", () => {
    const r = promosQueAplican(promos, { origen: "combo", id: COMBO_FACIAL });
    expect(r.map((p) => p.id)).toEqual(["p1"]);
  });

  it("sin nada elegido todavía, no ofrece ninguna", () => {
    // Ofrecer promos antes de saber qué se vende invita a elegir una que
    // después no va a aplicar.
    expect(promosQueAplican(promos, null)).toEqual([]);
  });
});
