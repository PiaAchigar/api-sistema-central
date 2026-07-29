import { z } from "zod";

export const TRIGGERS = ["incoming_message", "deal_stage_changed"] as const;
export const ACTIONS = ["reply_text", "change_deal_stage", "assign_agent"] as const;
const CHANNELS = ["whatsapp", "instagram", "facebook", "email"] as const;
const STAGES = [
  "lead",
  "contactado",
  "presupuestado",
  "senia_pagada",
  "confirmado",
  "completado",
] as const;

const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("channel_is"), value: z.enum(CHANNELS) }),
  z.object({ type: z.literal("message_contains"), value: z.string().min(1) }),
  z.object({ type: z.literal("deal_to_stage"), value: z.enum(STAGES) }),
]);

export function actionConfigFor(actionType: (typeof ACTIONS)[number]) {
  switch (actionType) {
    case "reply_text":
      return z.object({ text: z.string().min(1) });
    case "change_deal_stage":
      return z.object({ stage: z.enum(STAGES) });
    case "assign_agent":
      return z.object({ agentId: z.string().uuid() });
  }
}

const VALID_ACTIONS: Record<string, string[]> = {
  incoming_message: ["reply_text", "assign_agent"],
  deal_stage_changed: ["change_deal_stage", "assign_agent"],
};
const VALID_CONDITIONS: Record<string, string[]> = {
  incoming_message: ["channel_is", "message_contains"],
  deal_stage_changed: ["deal_to_stage"],
};

export const ruleBody = z
  .object({
    name: z.string().min(1),
    isActive: z.boolean().optional(),
    triggerType: z.enum(TRIGGERS),
    conditions: z.array(conditionSchema),
    actionType: z.enum(ACTIONS),
    actionConfig: z.record(z.unknown()),
  })
  .superRefine((r, ctx) => {
    if (!(VALID_ACTIONS[r.triggerType] ?? []).includes(r.actionType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `La acción "${r.actionType}" no es válida para ese disparador`,
      });
    }
    for (const cond of r.conditions) {
      if (!(VALID_CONDITIONS[r.triggerType] ?? []).includes(cond.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `La condición "${cond.type}" no aplica a ese disparador`,
        });
      }
    }
    if (!actionConfigFor(r.actionType).safeParse(r.actionConfig).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "La config de la acción es inválida" });
    }
  });
