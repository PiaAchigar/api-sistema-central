import { describe, expect, it } from "vitest";
import { assembleCombo } from "./combos.repo";

const combo = {
  id: "c1",
  name: "Depilación completa",
  priceType: "percentage",
  fixedPrice: null,
  discountPercentage: "20.00",
  validityMonths: 12,
  isActive: true,
  isVisibleWeb: true,
  displayOrder: 0,
};

const lineas = [
  { id: "l1", serviceId: "s1", serviceName: "Media pierna", serviceIsActive: true,
    sessionsIncluded: 8, servicePrice: "10000.00" },
  { id: "l2", serviceId: "s2", serviceName: "Axila", serviceIsActive: true,
    sessionsIncluded: 4, servicePrice: "5000.00" },
];

describe("assembleCombo", () => {
  it("calcula el subtotal multiplicando precio por sesiones de cada línea", () => {
    expect(assembleCombo(combo, lineas).servicesSubtotal).toBe(100000);
  });

  it("aplica el descuento porcentual al precio final", () => {
    expect(assembleCombo(combo, lineas).finalAmount).toBe(80000);
  });

  it("con precio fijo devuelve ese monto e ignora el subtotal", () => {
    const fijo = { ...combo, priceType: "fixed", fixedPrice: "65000.00", discountPercentage: null };
    expect(assembleCombo(fijo, lineas).finalAmount).toBe(65000);
  });

  it("convierte a número los decimal que Drizzle devuelve como string", () => {
    // Si esto se rompe, el front compara "80000" > 0 y muestra cualquier cosa.
    const out = assembleCombo(combo, lineas);
    expect(typeof out.discountPercentage).toBe("number");
    expect(typeof out.lines[0]!.servicePrice).toBe("number");
  });

  it("marca hasInactiveService si ALGUNA línea tiene el servicio archivado", () => {
    const conArchivado = [lineas[0]!, { ...lineas[1]!, serviceIsActive: false }];
    expect(assembleCombo(combo, conArchivado).hasInactiveService).toBe(true);
  });

  it("no marca hasInactiveService si están todos activos", () => {
    expect(assembleCombo(combo, lineas).hasInactiveService).toBe(false);
  });

  it("sin líneas da subtotal 0 y no rompe", () => {
    const out = assembleCombo(combo, []);
    expect(out.servicesSubtotal).toBe(0);
    expect(out.hasInactiveService).toBe(false);
  });
});
