import { describe, expect, it } from "vitest";
import { ruleBody } from "./automation.schema";

const base = {
  name: "Auto-respuesta WA",
  triggerType: "incoming_message",
  conditions: [{ type: "message_contains", value: "precio" }],
  actionType: "reply_text",
  actionConfig: { text: "Ya te paso los precios 💛" },
};

describe("ruleBody", () => {
  it("acepta una regla válida de mensaje→responder texto", () => {
    expect(ruleBody.safeParse(base).success).toBe(true);
  });
  it("acepta deal_stage_changed→change_deal_stage con deal_to_stage", () => {
    const r = ruleBody.safeParse({
      name: "Mover a confirmado",
      triggerType: "deal_stage_changed",
      conditions: [{ type: "deal_to_stage", value: "senia_pagada" }],
      actionType: "change_deal_stage",
      actionConfig: { stage: "confirmado" },
    });
    expect(r.success).toBe(true);
  });
  it("rechaza par disparador→acción inválido", () => {
    expect(
      ruleBody.safeParse({ ...base, actionType: "change_deal_stage", actionConfig: { stage: "lead" } })
        .success,
    ).toBe(false);
  });
  it("rechaza condición que no aplica al disparador", () => {
    expect(
      ruleBody.safeParse({ ...base, conditions: [{ type: "deal_to_stage", value: "lead" }] }).success,
    ).toBe(false);
  });
  it("rechaza actionConfig con forma incorrecta", () => {
    expect(ruleBody.safeParse({ ...base, actionConfig: {} }).success).toBe(false);
  });
  it("rechaza name vacío", () => {
    expect(ruleBody.safeParse({ ...base, name: "" }).success).toBe(false);
  });
  it("acepta incoming_message→reply_faq con actionConfig vacío", () => {
    const r = ruleBody.safeParse({
      name: "Autorespondedor FAQ",
      triggerType: "incoming_message",
      conditions: [],
      actionType: "reply_faq",
      actionConfig: {},
    });
    expect(r.success).toBe(true);
  });
});
