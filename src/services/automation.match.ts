export type TriggerType = "incoming_message" | "deal_stage_changed";
export type ActionType = "reply_text" | "change_deal_stage" | "assign_agent" | "reply_faq";

export type Condition =
  | { type: "channel_is"; value: string }
  | { type: "message_contains"; value: string }
  | { type: "deal_to_stage"; value: string };

export type AutomationEvent =
  | {
      type: "incoming_message";
      conversationId: string;
      contactId: string | null;
      channel: string | null;
      text: string;
    }
  | { type: "deal_stage_changed"; dealId: string; contactId: string | null; toStage: string };

/** minúsculas + sin acentos, para que "estan" matchee "están". */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function matchesOne(cond: Condition, event: AutomationEvent): boolean {
  switch (cond.type) {
    case "channel_is":
      return event.type === "incoming_message" && event.channel === cond.value;
    case "message_contains":
      return (
        event.type === "incoming_message" &&
        normalize(event.text).includes(normalize(cond.value))
      );
    case "deal_to_stage":
      return event.type === "deal_stage_changed" && event.toStage === cond.value;
    default:
      return false;
  }
}

/** Todas las condiciones deben cumplirse (AND). Sin condiciones → matchea. */
export function matchesConditions(conditions: Condition[], event: AutomationEvent): boolean {
  return conditions.every((c) => matchesOne(c, event));
}

export type FaqRecord = { id: string; answer: string; keywords: string[] };

/** Primera FAQ activa cuyas keywords aparecen en el texto (normalizado). El
 *  orden de `faqs` decide el desempate si matchean varias: gana la primera. */
export function matchFaq(faqs: FaqRecord[], text: string): { id: string; answer: string } | null {
  const normalizedText = normalize(text);
  for (const faq of faqs) {
    if (faq.keywords.some((k) => normalizedText.includes(normalize(k)))) {
      return { id: faq.id, answer: faq.answer };
    }
  }
  return null;
}
