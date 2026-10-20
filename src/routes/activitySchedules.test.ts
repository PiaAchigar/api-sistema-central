import { describe, expect, it } from "vitest";
import { horarioBody, horarioPatchBody, horarioListQuery } from "./activitySchedules";

// Tests de schema (sin base): el body del POST y del PATCH de horarios.

const base = { dayOfWeek: 1, startTime: "10:00:00", endTime: "11:00:00" };

describe("horarioBody (POST de horarios)", () => {
  it("acepta un cupo entero positivo", () => {
    const r = horarioBody.safeParse({ ...base, capacity: 8 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.capacity).toBe(8);
  });

  it("acepta el POST sin capacity (queda sin límite declarado)", () => {
    const r = horarioBody.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("acepta capacity null (sin límite declarado)", () => {
    const r = horarioBody.safeParse({ ...base, capacity: null });
    expect(r.success).toBe(true);
  });

  it("rechaza capacity 0", () => {
    expect(horarioBody.safeParse({ ...base, capacity: 0 }).success).toBe(false);
  });

  it("rechaza capacity negativo", () => {
    expect(horarioBody.safeParse({ ...base, capacity: -1 }).success).toBe(false);
  });

  it("rechaza capacity no entero", () => {
    expect(horarioBody.safeParse({ ...base, capacity: 2.5 }).success).toBe(false);
  });

  it("rechaza endTime igual a startTime con el mensaje de negocio", () => {
    const r = horarioBody.safeParse({ ...base, endTime: "10:00:00" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toContain(
        "La hora de fin tiene que ser posterior a la de inicio"
      );
    }
  });

  it("rechaza endTime anterior a startTime", () => {
    const r = horarioBody.safeParse({ ...base, startTime: "12:00:00", endTime: "11:00:00" });
    expect(r.success).toBe(false);
  });
});

describe("horarioPatchBody (PATCH de horarios, todo opcional)", () => {
  it("acepta un cambio de capacity solo", () => {
    expect(horarioPatchBody.safeParse({ capacity: 5 }).success).toBe(true);
  });

  it("acepta isActive (Pausar / Reactivar)", () => {
    const r = horarioPatchBody.safeParse({ isActive: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isActive).toBe(false);
  });

  it("acepta capacity null en el PATCH (quitar el límite)", () => {
    const r = horarioPatchBody.safeParse({ capacity: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.capacity).toBeNull();
  });

  it("rechaza capacity 0 también en el PATCH", () => {
    expect(horarioPatchBody.safeParse({ capacity: 0 }).success).toBe(false);
  });

  it("no valida el orden de horas si viene solo una de las dos", () => {
    expect(horarioPatchBody.safeParse({ startTime: "15:00:00" }).success).toBe(true);
    expect(horarioPatchBody.safeParse({ endTime: "09:00:00" }).success).toBe(true);
  });

  it("valida el orden de horas si vienen las dos", () => {
    const r = horarioPatchBody.safeParse({ startTime: "11:00:00", endTime: "10:00:00" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toContain(
        "La hora de fin tiene que ser posterior a la de inicio"
      );
    }
  });
});

describe("horarioListQuery (GET de horarios)", () => {
  it("sin includeInactive: solo activos (includeInactive false)", () => {
    const r = horarioListQuery.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.includeInactive).toBe(false);
  });

  it("includeInactive=true incluye pausados", () => {
    const r = horarioListQuery.safeParse({ includeInactive: "true" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.includeInactive).toBe(true);
  });

  it("includeInactive=false equivale al default", () => {
    const r = horarioListQuery.safeParse({ includeInactive: "false" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.includeInactive).toBe(false);
  });

  it("rechaza un valor que no sea true/false", () => {
    expect(horarioListQuery.safeParse({ includeInactive: "si" }).success).toBe(false);
  });
});
