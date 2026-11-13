import { describe, expect, it } from "vitest";
import { nombreCorto } from "./nombre-corto";

describe("nombreCorto", () => {
  it.each([
    ["Lucía Celano", null, "Lucía Ce."],
    ["Agostina Ríos", null, "Agostina Rí."],
    ["Laura", null, "Laura"],
    ["laura   pérez gómez", null, "Laura Gó."],
    ["  ", "a@x.com", "a@x.com"],
    [null, "a@x.com", "a@x.com"],
    ["", null, "Sin nombre"],
    [null, null, "Sin nombre"],
  ])("%s / %s → %s", (n, e, esperado) => {
    expect(nombreCorto(n, e)).toBe(esperado);
  });
});
