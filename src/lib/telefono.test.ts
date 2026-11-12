import { describe, expect, it } from "vitest";
import { aWhatsappId, clave, diagnosticoTelefono } from "./telefono";

describe("diagnosticoTelefono", () => {
  it.each([
    ["005491130317884", { ok: true, whatsappId: "5491130317884" }],
    ["+54 9 11 3031-7884", { ok: true, whatsappId: "5491130317884" }],
    ["5491130317884", { ok: true, whatsappId: "5491130317884" }],
    ["541130317884", { ok: true, whatsappId: "5491130317884" }],
    ["1130317884", { ok: true, whatsappId: "5491130317884" }],
    ["3413285292", { ok: true, whatsappId: "5493413285292" }],
    ["1530317884", { ok: false, motivo: "con15" }],
    ["11 15 3031 7884", { ok: false, motivo: "con15" }],
    ["01130317884", { ok: false, motivo: "con0" }],
    ["03484688322", { ok: false, motivo: "con0" }],
    ["111111", { ok: false, motivo: "corto" }],
    ["159447519", { ok: false, motivo: "corto" }],
    ["005216643206631", { ok: false, motivo: "extranjero" }],
    ["0013852837291", { ok: false, motivo: "extranjero" }],
  ])("%s", (tel, esperado) => {
    expect(diagnosticoTelefono(tel)).toEqual(esperado);
  });
});

describe("clave", () => {
  it("toma los últimos 10 dígitos", () => {
    expect(clave("005491130317884")).toBe("1130317884");
  });
  it("teléfono corto o basura no tiene clave", () => {
    expect(clave("111111")).toBeNull();
    expect(clave(null)).toBeNull();
    expect(clave(undefined)).toBeNull();
  });
});

describe("aWhatsappId", () => {
  it("devuelve el id si es válido y null si no", () => {
    expect(aWhatsappId("1130317884")).toBe("5491130317884");
    expect(aWhatsappId("1530317884")).toBeNull();
  });
});
