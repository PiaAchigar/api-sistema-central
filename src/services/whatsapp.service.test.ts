// api-sistema-central/src/services/whatsapp.service.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWhatsAppText } from "./whatsapp.service";

const CREDENTIALS = { accessToken: "fake-token", phoneNumberId: "123456789" };

function mockFetchOnce(status: number, body = "") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(body, { status, statusText: `Status ${status}` }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendWhatsAppText — preservación del status HTTP real de Meta", () => {
  it("no lanza si Meta responde 200", async () => {
    mockFetchOnce(200);
    await expect(sendWhatsAppText(CREDENTIALS, "5491112345678", "hola")).resolves.toBeUndefined();
  });

  it("lanza con status 401 real cuando Meta rechaza el token", async () => {
    mockFetchOnce(401, "Invalid OAuth access token");
    await expect(sendWhatsAppText(CREDENTIALS, "5491112345678", "hola")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("lanza con status 429 real (rate limit) — no lo colapsa a 502", async () => {
    mockFetchOnce(429, "Too Many Requests");
    await expect(sendWhatsAppText(CREDENTIALS, "5491112345678", "hola")).rejects.toMatchObject({
      status: 429,
    });
  });

  it("lanza con status 403 real (forbidden) — no lo colapsa a 502", async () => {
    mockFetchOnce(403, "Forbidden");
    await expect(sendWhatsAppText(CREDENTIALS, "5491112345678", "hola")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("lanza con status 500 real (upstream error de Meta) — no lo colapsa a 502", async () => {
    mockFetchOnce(500, "Internal Server Error");
    await expect(sendWhatsAppText(CREDENTIALS, "5491112345678", "hola")).rejects.toMatchObject({
      status: 500,
    });
  });
});
