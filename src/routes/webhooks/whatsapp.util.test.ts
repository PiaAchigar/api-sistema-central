import { describe, expect, it } from "vitest";
import {
  extractIncomingMessage,
  parseHandshakeQuery,
  verifyWhatsAppSignature,
} from "./whatsapp.util";

describe("parseHandshakeQuery", () => {
  it("acepta un handshake válido", () => {
    const r = parseHandshakeQuery({
      "hub.mode": "subscribe",
      "hub.verify_token": "mi-token",
      "hub.challenge": "12345",
    });
    expect(r).toEqual({
      "hub.mode": "subscribe",
      "hub.verify_token": "mi-token",
      "hub.challenge": "12345",
    });
  });
  it("rechaza un hub.mode distinto de subscribe", () => {
    expect(
      parseHandshakeQuery({
        "hub.mode": "unsubscribe",
        "hub.verify_token": "x",
        "hub.challenge": "1",
      }),
    ).toBeNull();
  });
  it("rechaza si falta algún campo", () => {
    expect(parseHandshakeQuery({ "hub.mode": "subscribe" })).toBeNull();
  });
});

describe("verifyWhatsAppSignature", () => {
  const APP_SECRET = "mi-app-secret-de-prueba";

  it("acepta una firma calculada correctamente", async () => {
    const body = '{"entry":[]}';
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(APP_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(await verifyWhatsAppSignature(body, `sha256=${hex}`, APP_SECRET)).toBe(true);
  });

  it("rechaza una firma incorrecta", async () => {
    expect(await verifyWhatsAppSignature("body", "sha256=aabbcc", APP_SECRET)).toBe(false);
  });

  it("rechaza si falta el header", async () => {
    expect(await verifyWhatsAppSignature("body", undefined, APP_SECRET)).toBe(false);
  });

  it("rechaza un header sin el prefijo sha256=", async () => {
    expect(await verifyWhatsAppSignature("body", "aabbcc", APP_SECRET)).toBe(false);
  });
});

describe("extractIncomingMessage", () => {
  it("extrae from/waId/text de un payload real de Meta", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: "5491112345678", id: "wamid.ABC123", type: "text", text: { body: "hola" } },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(extractIncomingMessage(payload)).toEqual({
      from: "5491112345678",
      waId: "wamid.ABC123",
      text: "hola",
    });
  });

  it("devuelve null para un payload de status (sin messages)", () => {
    const payload = {
      entry: [{ changes: [{ value: { statuses: [{ status: "delivered" }] } }] }],
    };
    expect(extractIncomingMessage(payload)).toBeNull();
  });

  it("devuelve null para un mensaje que no es de texto", () => {
    const payload = {
      entry: [
        {
          changes: [
            { value: { messages: [{ from: "549111", id: "wamid.X", type: "image" }] } },
          ],
        },
      ],
    };
    expect(extractIncomingMessage(payload)).toBeNull();
  });

  it("devuelve null para un payload que no matchea la forma esperada", () => {
    expect(extractIncomingMessage({ foo: "bar" })).toBeNull();
  });
});
