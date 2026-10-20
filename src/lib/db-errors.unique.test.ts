import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./db-errors";

describe("isUniqueViolation", () => {
  it("reconoce 23505, directo o en cause, y filtra por índice", () => {
    const e = { code: "23505", constraint_name: "ux_a" };
    expect(isUniqueViolation(e)).toBe(true);
    expect(isUniqueViolation(e, "ux_a")).toBe(true);
    expect(isUniqueViolation(e, "ux_b")).toBe(false);
    expect(isUniqueViolation({ cause: e }, "ux_a")).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
