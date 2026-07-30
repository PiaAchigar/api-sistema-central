import type { Db } from "../db/client";
import { listActiveFaqs } from "../repositories/automation-faqs.repo";
import { insertRun, listActiveRulesByTrigger } from "../repositories/automations.repo";
import { assignDeal, updateDealStage } from "../repositories/deals.repo";
import { addAgentMessage, updateConversation } from "../repositories/conversations.repo";
import {
  matchesConditions,
  matchFaq,
  type AutomationEvent,
  type Condition,
} from "./automation.match";

/** Demora antes de enviar una respuesta automática, para que no se sienta
 *  instantánea/robótica sino como si la estuviera tipeando una persona. */
const HUMAN_LIKE_REPLY_DELAY_MS = 5000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ctxIds(event: AutomationEvent) {
  if (event.type === "incoming_message") {
    return { contactId: event.contactId, conversationId: event.conversationId, dealId: null };
  }
  return { contactId: event.contactId, conversationId: null, dealId: event.dealId };
}

type ActionResult = { status: "executed" | "skipped"; detail: string };

async function executeAction(
  db: Db,
  rule: { actionType: string | null; actionConfig: unknown },
  event: AutomationEvent,
): Promise<ActionResult | void> {
  const cfg = (rule.actionConfig as Record<string, unknown> | null) ?? {};
  switch (rule.actionType) {
    case "reply_text":
      if (event.type === "incoming_message") {
        await sleep(HUMAN_LIKE_REPLY_DELAY_MS);
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
    case "reply_faq": {
      if (event.type !== "incoming_message") return;
      const rawFaqs = await listActiveFaqs(db);
      // Filtramos filas sin answer/keywords (columnas nullable en el schema):
      // matchFaq requiere FaqRecord con ambos campos no-nulos.
      const faqs = rawFaqs.flatMap((f) =>
        f.answer !== null && f.keywords !== null
          ? [{ id: f.id, answer: f.answer, keywords: f.keywords }]
          : [],
      );
      const match = matchFaq(faqs, event.text);
      if (!match) return { status: "skipped", detail: "reply_faq: sin FAQ coincidente" };
      await sleep(HUMAN_LIKE_REPLY_DELAY_MS);
      await addAgentMessage(db, event.conversationId, match.answer);
      return { status: "executed", detail: `reply_faq: ${match.id}` };
    }
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
      const result = await executeAction(db, rule, event);
      await insertRun(db, {
        ruleId: rule.id,
        triggerType: event.type,
        ...ctxIds(event),
        status: result?.status ?? "executed",
        detail: result?.detail ?? rule.actionType,
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
