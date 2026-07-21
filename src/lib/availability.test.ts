import { describe, expect, it } from "vitest";
import { diffWeeklyAvailability } from "./availability";

describe("diffWeeklyAvailability", () => {
  it("franja nueva en un día sin nada antes → crea", () => {
    const r = diffWeeklyAvailability(
      [],
      [{ dayOfWeek: 1, workStartTime: "09:00", workEndTime: "12:00" }],
    );
    expect(r.toCreate).toEqual([{ dayOfWeek: 1, workStartTime: "09:00", workEndTime: "12:00" }]);
    expect(r.toCloseIds).toEqual([]);
  });

  it("día quitado del borrador → cierra", () => {
    const r = diffWeeklyAvailability(
      [{ id: "a", dayOfWeek: 1, workStartTime: "09:00", workEndTime: "12:00" }],
      [],
    );
    expect(r.toCreate).toEqual([]);
    expect(r.toCloseIds).toEqual(["a"]);
  });

  it("horario cambiado → cierra el viejo y crea el nuevo", () => {
    const r = diffWeeklyAvailability(
      [{ id: "a", dayOfWeek: 1, workStartTime: "09:00", workEndTime: "12:00" }],
      [{ dayOfWeek: 1, workStartTime: "09:00", workEndTime: "13:00" }],
    );
    expect(r.toCloseIds).toEqual(["a"]);
    expect(r.toCreate).toEqual([{ dayOfWeek: 1, workStartTime: "09:00", workEndTime: "13:00" }]);
  });

  it("sin cambios → no toca nada", () => {
    const same = [{ id: "a", dayOfWeek: 1, workStartTime: "09:00", workEndTime: "12:00" }];
    const r = diffWeeklyAvailability(same, [
      { dayOfWeek: 1, workStartTime: "09:00", workEndTime: "12:00" },
    ]);
    expect(r.toCreate).toEqual([]);
    expect(r.toCloseIds).toEqual([]);
  });

  it("turno partido: dos franjas el mismo día, se agrega una segunda", () => {
    const current = [{ id: "a", dayOfWeek: 4, workStartTime: "09:00", workEndTime: "13:00" }];
    const desired = [
      { dayOfWeek: 4, workStartTime: "09:00", workEndTime: "13:00" },
      { dayOfWeek: 4, workStartTime: "14:00", workEndTime: "18:00" },
    ];
    const r = diffWeeklyAvailability(current, desired);
    expect(r.toCreate).toEqual([{ dayOfWeek: 4, workStartTime: "14:00", workEndTime: "18:00" }]);
    expect(r.toCloseIds).toEqual([]);
  });

  it("mezcla: un día sin cambios, otro quitado, otro nuevo", () => {
    const current = [
      { id: "keep", dayOfWeek: 1, workStartTime: "09:00", workEndTime: "12:00" },
      { id: "remove", dayOfWeek: 3, workStartTime: "13:00", workEndTime: "18:00" },
    ];
    const desired = [
      { dayOfWeek: 1, workStartTime: "09:00", workEndTime: "12:00" },
      { dayOfWeek: 5, workStartTime: "09:00", workEndTime: "18:00" },
    ];
    const r = diffWeeklyAvailability(current, desired);
    expect(r.toCreate).toEqual([{ dayOfWeek: 5, workStartTime: "09:00", workEndTime: "18:00" }]);
    expect(r.toCloseIds).toEqual(["remove"]);
  });
});
