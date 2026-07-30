import { describe, expect, it } from "vitest";
import { matchesConditions, matchFaq, type AutomationEvent } from "./automation.match";

const msg: AutomationEvent = {
  type: "incoming_message",
  conversationId: "c1",
  contactId: "ct1",
  channel: "whatsapp",
  text: "Hola, quiero saber el PRECIO del masaje",
};
const deal: AutomationEvent = {
  type: "deal_stage_changed",
  dealId: "d1",
  contactId: "ct1",
  toStage: "senia_pagada",
};

describe("matchesConditions", () => {
  it("sin condiciones → siempre matchea", () => {
    expect(matchesConditions([], msg)).toBe(true);
  });
  it("channel_is matchea el canal correcto", () => {
    expect(matchesConditions([{ type: "channel_is", value: "whatsapp" }], msg)).toBe(true);
    expect(matchesConditions([{ type: "channel_is", value: "email" }], msg)).toBe(false);
  });
  it("message_contains es case-insensitive", () => {
    expect(matchesConditions([{ type: "message_contains", value: "precio" }], msg)).toBe(true);
    expect(matchesConditions([{ type: "message_contains", value: "turno" }], msg)).toBe(false);
  });
  it("message_contains ignora acentos en el mensaje y en la condición", () => {
    const horario: AutomationEvent = {
      type: "incoming_message",
      conversationId: "c1",
      contactId: "ct1",
      channel: "whatsapp",
      text: "¿Hasta qué hora están?",
    };
    expect(matchesConditions([{ type: "message_contains", value: "hora" }], horario)).toBe(true);
    expect(matchesConditions([{ type: "message_contains", value: "estan" }], horario)).toBe(true);
    expect(matchesConditions([{ type: "message_contains", value: "horário" }], horario)).toBe(
      false,
    );
  });
  it("deal_to_stage matchea la etapa nueva", () => {
    expect(matchesConditions([{ type: "deal_to_stage", value: "senia_pagada" }], deal)).toBe(true);
    expect(matchesConditions([{ type: "deal_to_stage", value: "lead" }], deal)).toBe(false);
  });
  it("AND: todas deben cumplirse", () => {
    expect(
      matchesConditions(
        [{ type: "channel_is", value: "whatsapp" }, { type: "message_contains", value: "precio" }],
        msg,
      ),
    ).toBe(true);
    expect(
      matchesConditions(
        [{ type: "channel_is", value: "whatsapp" }, { type: "message_contains", value: "turno" }],
        msg,
      ),
    ).toBe(false);
  });
  it("condición de otro tipo de evento → no matchea", () => {
    expect(matchesConditions([{ type: "channel_is", value: "whatsapp" }], deal)).toBe(false);
    expect(matchesConditions([{ type: "deal_to_stage", value: "senia_pagada" }], msg)).toBe(false);
  });
});

describe("matchFaq", () => {
  const faqs = [
    { id: "f1", answer: "L-V de 9 a 20", keywords: ["hora", "horario", "abren"] },
    { id: "f2", answer: "Los precios varían según el servicio", keywords: ["precio", "cuanto sale"] },
  ];

  it("sin FAQs → null", () => {
    expect(matchFaq([], "hola")).toBeNull();
  });
  it("matchea por la primera keyword de una FAQ", () => {
    expect(matchFaq(faqs, "¿qué hora es?")).toEqual({ id: "f1", answer: "L-V de 9 a 20" });
  });
  it("matchea por una keyword que no es la primera de la lista", () => {
    expect(matchFaq(faqs, "no se si abren los domingos")).toEqual({
      id: "f1",
      answer: "L-V de 9 a 20",
    });
  });
  it("es insensible a mayúsculas y acentos", () => {
    expect(matchFaq(faqs, "HASTA QUE HORA ESTAN")).toEqual({ id: "f1", answer: "L-V de 9 a 20" });
  });
  it("ninguna keyword matchea → null", () => {
    expect(matchFaq(faqs, "quiero cancelar mi turno")).toBeNull();
  });
  it("si dos FAQs matchean, gana la primera del array (la más antigua)", () => {
    const both = [
      { id: "old", answer: "Respuesta vieja", keywords: ["turno"] },
      { id: "new", answer: "Respuesta nueva", keywords: ["turno"] },
    ];
    expect(matchFaq(both, "quiero un turno")).toEqual({ id: "old", answer: "Respuesta vieja" });
  });
});
