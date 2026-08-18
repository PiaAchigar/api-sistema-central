import { describe, expect, it } from "vitest";
import { priceLabelFor } from "./treatments.repo";

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
