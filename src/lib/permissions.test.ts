import { describe, expect, it } from "vitest";
import { can } from "./permissions";

describe("can() — matriz §1.7", () => {
  it("admin puede gestionar todo el catálogo", () => {
    expect(can("admin", "catalogo", "manage")).toBe(true);
  });
  it("manager gestiona catálogo (crear/archivar)", () => {
    expect(can("manager", "catalogo", "manage")).toBe(true);
  });
  it("operator edita catálogo pero NO gestiona", () => {
    expect(can("operator", "catalogo", "edit")).toBe(true);
    expect(can("operator", "catalogo", "manage")).toBe(false);
  });
  it("operator NO accede a proveedoras", () => {
    expect(can("operator", "proveedoras", "view")).toBe(false);
  });
  it("manager gestiona proveedoras", () => {
    expect(can("manager", "proveedoras", "manage")).toBe(true);
  });
  it("sales solo CRM", () => {
    expect(can("sales", "crm", "manage")).toBe(true);
    expect(can("sales", "catalogo", "view")).toBe(false);
    expect(can("sales", "facturacion", "view")).toBe(false);
  });
  it("accountant solo ve facturación", () => {
    expect(can("accountant", "facturacion", "view")).toBe(true);
    expect(can("accountant", "facturacion", "edit")).toBe(false);
    expect(can("accountant", "crm", "view")).toBe(false);
  });
  it("config-local y usuarios: solo admin", () => {
    expect(can("manager", "config-local", "view")).toBe(false);
    expect(can("manager", "usuarios", "view")).toBe(false);
    expect(can("admin", "config-local", "manage")).toBe(true);
  });
  it("rol nulo nunca puede", () => {
    expect(can(null, "agenda", "view")).toBe(false);
  });
});
