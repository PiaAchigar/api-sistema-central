import { describe, expect, it } from "vitest";
import { matchesConditions, type AutomationEvent } from "./automation.match";

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
