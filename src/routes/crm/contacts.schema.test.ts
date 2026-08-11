import { describe, expect, it } from "vitest";
import { contactInput, listQuery } from "./contacts.schema";

describe("contactInput", () => {
  it("acepta un contacto mínimo (solo name) y aplica status default", () => {
    const r = contactInput.safeParse({ name: "Ana" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.status).toBe("prospect");
  });

  it("acepta todos los campos nuevos", () => {
    const r = contactInput.safeParse({
      name: "Ana",
      email: "a@b.com",
      phone: "123",
      status: "customer",
      notes: "x",
      whatsappId: "wa1",
      instagramId: "ig1",
      facebookId: "fb1",
      birthdate: "1990-05-20",
      tags: ["vip", "recurrente"],
      preferredService: "Corte",
      address: "Calle 1",
      city: "CABA",
      postalCode: "1000",
      country: "AR",
      isArchived: true,
    });
    expect(r.success).toBe(true);
  });

  it("rechaza name vacío", () => {
    expect(contactInput.safeParse({ name: "" }).success).toBe(false);
  });

  it("rechaza email inválido", () => {
    expect(contactInput.safeParse({ name: "Ana", email: "no-email" }).success).toBe(false);
  });

  it("rechaza birthdate mal formado", () => {
    expect(contactInput.safeParse({ name: "Ana", birthdate: "20/05/1990" }).success).toBe(false);
  });

  it("partial() acepta solo isArchived (para PATCH de archivar)", () => {
    expect(contactInput.partial().safeParse({ isArchived: true }).success).toBe(true);
  });
});

describe("listQuery", () => {
  it("includeArchived default false", () => {
    const r = listQuery.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.includeArchived).toBe(false);
  });

  it("includeArchived='true' → true", () => {
    const r = listQuery.safeParse({ includeArchived: "true" });
    expect(r.success && r.data.includeArchived).toBe(true);
  });

  it("includeArchived='false' → false (no coerción ingenua)", () => {
    const r = listQuery.safeParse({ includeArchived: "false" });
    expect(r.success && r.data.includeArchived).toBe(false);
  });

  it("ignora status: el campo dejó de filtrarse (está nulo en los 5611 de prod)", () => {
    const r = listQuery.safeParse({ status: "prospect" });
    expect(r.success).toBe(true);
    if (r.success) expect("status" in r.data).toBe(false);
  });

  it("aplica limit y offset por defecto", () => {
    const r = listQuery.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(50);
      expect(r.data.offset).toBe(0);
    }
  });

  it("coacciona limit y offset desde string", () => {
    const r = listQuery.safeParse({ limit: "10", offset: "100" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(10);
      expect(r.data.offset).toBe(100);
    }
  });

  it("rechaza limit mayor a 100", () => {
    expect(listQuery.safeParse({ limit: "500" }).success).toBe(false);
  });
});
