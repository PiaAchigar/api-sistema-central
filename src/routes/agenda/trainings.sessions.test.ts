import { describe, expect, it } from "vitest";
import { encuentroBody, encuentroPatchBody, generarBody } from "./trainings";

const base = { sessionNumber: 1, sessionDate: "2026-11-04", startTime: "10:00:00", endTime: "12:00:00" };

describe("encuentroBody", () => {
  it("acepta un encuentro válido", () => {
    expect(encuentroBody.safeParse({ ...base, capacity: 8 }).success).toBe(true);
  });
  it("rechaza endTime <= startTime con el mensaje de negocio", () => {
    const r = encuentroBody.safeParse({ ...base, endTime: "10:00:00" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toContain("La hora de fin tiene que ser posterior a la de inicio");
    }
  });
  it("rechaza capacity < 1", () => {
    const r = encuentroBody.safeParse({ ...base, capacity: 0 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.path).toEqual(["capacity"]);
  });
});

describe("encuentroPatchBody", () => {
  it("valida el orden solo si vienen las dos horas", () => {
    expect(encuentroPatchBody.safeParse({ startTime: "15:00:00" }).success).toBe(true);
    expect(encuentroPatchBody.safeParse({ startTime: "15:00:00", endTime: "14:00:00" }).success).toBe(false);
  });
  it("rechaza capacity 0 y acepta isActive", () => {
    expect(encuentroPatchBody.safeParse({ capacity: 0 }).success).toBe(false);
    expect(encuentroPatchBody.safeParse({ isActive: false }).success).toBe(true);
  });
});

describe("generarBody", () => {
  it("rechaza endTime <= startTime y día fuera de 0..6", () => {
    expect(generarBody.safeParse({ desde: "2026-11-02", diaDeLaSemana: 3, startTime: "10:00:00", endTime: "09:00:00" }).success).toBe(false);
    expect(generarBody.safeParse({ desde: "2026-11-02", diaDeLaSemana: 7, startTime: "10:00:00", endTime: "11:00:00" }).success).toBe(false);
  });

  it("rechaza cantidad < 1", () => {
    const ok = { desde: "2026-11-02", diaDeLaSemana: 3, startTime: "10:00:00", endTime: "11:00:00" };
    expect(generarBody.safeParse({ ...ok, cantidad: 0 }).success).toBe(false);
    expect(generarBody.safeParse({ ...ok, cantidad: 2 }).success).toBe(true);
  });
});
