import type { Db } from "../db/client";
import { insertRun, listActiveRulesByTrigger } from "../repositories/automations.repo";
import { assignDeal, updateDealStage } from "../repositories/deals.repo";
import { addAgentMessage, updateConversation } from "../repositories/conversations.repo";
import { matchesConditions, type AutomationEvent, type Condition } from "./automation.match";

function ctxIds(event: AutomationEvent) {
  if (event.type === "incoming_message") {
    return { contactId: event.contactId, conversationId: event.conversationId, dealId: null };
  }
  return { contactId: event.contactId, conversationId: null, dealId: event.dealId };
}

async function executeAction(
  db: Db,
  rule: { actionType: string | null; actionConfig: unknown },
  event: AutomationEvent,
) {
  const cfg = (rule.actionConfig as Record<string, unknown> | null) ?? {};
  switch (rule.actionType) {
    case "reply_text":
      if (event.type === "incoming_message") {
        await addAgentMessage(db, event.conversationId, String(cfg.text ?? ""));
      }
      return;
    case "change_deal_stage":
      if (event.type === "deal_stage_changed") {
        await updateDealStage(db, event.dealId, String(cfg.stage));
      }
      return;
    case "assign_agent":
      if (event.type === "incoming_message") {
        await updateConversation(db, event.conversationId, {
          assignedAgentId: String(cfg.agentId),
        });
      } else {
        await assignDeal(db, event.dealId, String(cfg.agentId));
      }
      return;
  }
}

/** Corre las reglas activas del disparador contra el evento. BEST-EFFORT:
 *  cualquier error se captura y (cuando se puede) se registra, sin romper el
 *  request que disparó el evento. */
export async function runAutomations(db: Db, event: AutomationEvent) {
  let rules;
  try {
    rules = await listActiveRulesByTrigger(db, event.type);
  } catch {
    return;
  }
  for (const rule of rules) {
    const conditions = (rule.conditions as Condition[] | null) ?? [];
    if (!matchesConditions(conditions, event)) continue;
    try {
      await executeAction(db, rule, event);
      await insertRun(db, {
        ruleId: rule.id,
        triggerType: event.type,
        ...ctxIds(event),
        status: "executed",
        detail: rule.actionType,
      });
    } catch (e) {
      await insertRun(db, {
        ruleId: rule.id,
        triggerType: event.type,
        ...ctxIds(event),
        status: "error",
        detail: String(e),
      }).catch(() => {});
    }
  }
}
