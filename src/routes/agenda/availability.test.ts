import { describe, expect, it } from "vitest";
import { availabilityQuery, monthQuery } from "./availability";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("availabilityQuery", () => {
  it("sin excludeAppointmentId sigue siendo válida (el camino de siempre)", () => {
    expect(availabilityQuery.safeParse({ date: "2026-10-19" }).success).toBe(true);
  });

  it("acepta excludeAppointmentId uuid", () => {
    expect(
      availabilityQuery.safeParse({ date: "2026-10-19", excludeAppointmentId: UUID }).success,
    ).toBe(true);
  });

  it("rechaza excludeAppointmentId que no es uuid", () => {
    expect(
      availabilityQuery.safeParse({ date: "2026-10-19", excludeAppointmentId: "x" }).success,
    ).toBe(false);
  });
});

describe("monthQuery", () => {
  it("pide proveedora y mes", () => {
    expect(monthQuery.safeParse({ providerId: UUID, month: "2026-10" }).success).toBe(true);
  });

  it("la proveedora es obligatoria (el calendario siempre pinta para UNA)", () => {
    expect(monthQuery.safeParse({ month: "2026-10" }).success).toBe(false);
  });

  it("rechaza un mes mal formado o inexistente", () => {
    expect(monthQuery.safeParse({ providerId: UUID, month: "2026-13" }).success).toBe(false);
    expect(monthQuery.safeParse({ providerId: UUID, month: "2026-1" }).success).toBe(false);
    expect(monthQuery.safeParse({ providerId: UUID, month: "2026-10-01" }).success).toBe(false);
  });
});
