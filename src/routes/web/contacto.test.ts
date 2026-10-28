import { describe, expect, it } from "vitest";
import { consultaWebBody, esUnBot } from "./contacto";

const valida = {
  nombre: "Ana",
  email: "ana@ejemplo.com",
  telefono: "+54 9 11 5555-0001",
  mensaje: "Hola, quiero info",
};

describe("consultaWebBody", () => {
  it("acepta una consulta completa", () => {
    expect(consultaWebBody.safeParse(valida).success).toBe(true);
  });

  it("rechaza un mail mal escrito", () => {
    expect(consultaWebBody.safeParse({ ...valida, email: "ana@" }).success).toBe(false);
  });

  it("rechaza un teléfono con menos de 8 dígitos", () => {
    expect(consultaWebBody.safeParse({ ...valida, telefono: "+54 11" }).success).toBe(false);
  });

  it("rechaza campos vacíos o sólo espacios", () => {
    expect(consultaWebBody.safeParse({ ...valida, nombre: "   " }).success).toBe(false);
    expect(consultaWebBody.safeParse({ ...valida, mensaje: "" }).success).toBe(false);
  });

  it("rechaza un mensaje de más de 2000 caracteres", () => {
    expect(consultaWebBody.safeParse({ ...valida, mensaje: "a".repeat(2001) }).success).toBe(false);
  });
});

describe("esUnBot", () => {
  it("una persona no ve el campo trampa y lo deja vacío", () => {
    expect(esUnBot(consultaWebBody.parse(valida))).toBe(false);
  });

  it("un bot llena todos los campos, también el trampa", () => {
    expect(esUnBot(consultaWebBody.parse({ ...valida, empresa: "Spam SA" }))).toBe(true);
  });
});
