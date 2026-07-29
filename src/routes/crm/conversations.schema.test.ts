import { describe, expect, it } from "vitest";
import {
  createConversationBody,
  listConversationsQuery,
  patchConversationBody,
  sendMessageBody,
} from "./conversations.schema";

const UUID = "00000000-0000-0000-0000-000000000001";

describe("createConversationBody", () => {
  it("acepta contactId uuid + channel válido", () => {
    const r = createConversationBody.safeParse({ contactId: UUID, channel: "whatsapp" });
    expect(r.success).toBe(true);
  });
  it("rechaza channel desconocido", () => {
    const r = createConversationBody.safeParse({ contactId: UUID, channel: "telegram" });
    expect(r.success).toBe(false);
  });
  it("rechaza contactId no-uuid", () => {
    const r = createConversationBody.safeParse({ contactId: "x", channel: "email" });
    expect(r.success).toBe(false);
  });
});

describe("sendMessageBody", () => {
  it("acepta content no vacío", () => {
    expect(sendMessageBody.safeParse({ content: "hola" }).success).toBe(true);
  });
  it("rechaza content vacío", () => {
    expect(sendMessageBody.safeParse({ content: "" }).success).toBe(false);
  });
});

describe("patchConversationBody", () => {
  it("acepta solo status", () => {
    expect(patchConversationBody.safeParse({ status: "closed" }).success).toBe(true);
  });
  it("acepta assignedAgentId null (desasignar)", () => {
    expect(patchConversationBody.safeParse({ assignedAgentId: null }).success).toBe(true);
  });
  it("rechaza body vacío", () => {
    expect(patchConversationBody.safeParse({}).success).toBe(false);
  });
  it("rechaza status inválido", () => {
    expect(patchConversationBody.safeParse({ status: "pausada" }).success).toBe(false);
  });
});

describe("listConversationsQuery", () => {
  it("acepta vacío", () => {
    expect(listConversationsQuery.safeParse({}).success).toBe(true);
  });
  it("acepta filtros válidos", () => {
    const r = listConversationsQuery.safeParse({ channel: "instagram", status: "open", q: "ana" });
    expect(r.success).toBe(true);
  });
  it("rechaza channel inválido", () => {
    expect(listConversationsQuery.safeParse({ channel: "sms" }).success).toBe(false);
  });
});
