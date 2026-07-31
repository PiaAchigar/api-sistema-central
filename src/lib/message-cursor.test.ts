import { describe, expect, it } from "vitest";
import { decodeMessageCursor, encodeMessageCursor } from "./message-cursor";

describe("encodeMessageCursor / decodeMessageCursor", () => {
  it("round-trips fecha + id", () => {
    const createdAt = new Date("2026-07-15T12:34:56.000Z");
    const id = "00000000-0000-0000-0000-000000000001";
    const encoded = encodeMessageCursor({ createdAt, id });
    const decoded = decodeMessageCursor(encoded);
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(decoded.id).toBe(id);
  });

  it("rechaza cursor sin separador", () => {
    expect(() => decodeMessageCursor("sin-separador")).toThrow("Cursor inválido");
  });

  it("rechaza fecha inválida", () => {
    expect(() =>
      decodeMessageCursor("no-es-fecha_00000000-0000-0000-0000-000000000001"),
    ).toThrow("Cursor inválido");
  });

  it("rechaza id vacío", () => {
    expect(() => decodeMessageCursor("2026-07-15T12:34:56.000Z_")).toThrow("Cursor inválido");
  });
});
