export type TriggerType = "incoming_message" | "deal_stage_changed";
export type ActionType = "reply_text" | "change_deal_stage" | "assign_agent";

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
function normalize(s: string): string {
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
