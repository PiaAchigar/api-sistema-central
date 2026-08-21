import { describe, expect, it } from "vitest";
import { contactInput, listQuery } from "./contacts.schema";
import { todayLocal } from "../../lib/time";

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

  it("rechaza una fecha de nacimiento futura", () => {
    // La importación original dejó 1403 contactos nacidos entre 2029 y 2075
    // (años leídos en dos dígitos). Se repararon en la migración 1.33.0; esto
    // evita que vuelvan a entrar por la API.
    const r = contactInput.safeParse({ name: "Ana", birthdate: "2075-12-23" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toBe("La fecha de nacimiento no puede ser futura");
    }
  });

  it("acepta una fecha de nacimiento pasada y también la de hoy", () => {
    expect(contactInput.safeParse({ name: "Ana", birthdate: "1965-03-14" }).success).toBe(true);
    expect(contactInput.safeParse({ name: "Ana", birthdate: todayLocal() }).success).toBe(true);
  });

  it("acepta que no venga birthdate", () => {
    expect(contactInput.safeParse({ name: "Ana" }).success).toBe(true);
  });

  it("partial() acepta solo isArchived (para PATCH de archivar)", () => {
    expect(contactInput.partial().safeParse({ isArchived: true }).success).toBe(true);
  });

  it("partial() NO afloja la guarda de fecha futura", () => {
    // El PATCH de contactos valida con `contactInput.partial()`. Si `.partial()`
    // descartara el refine, la guarda solo cubriría el alta y se podría meter
    // una fecha futura editando un contacto — que es el camino más usado.
    const r = contactInput.partial().safeParse({ birthdate: "2075-12-23" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toBe("La fecha de nacimiento no puede ser futura");
    }
    expect(contactInput.partial().safeParse({ birthdate: "1965-03-14" }).success).toBe(true);
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
