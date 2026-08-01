import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError, generateEmbedding } from "./embedding";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VALID_VECTOR = Array.from({ length: 1536 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1));

describe("generateEmbedding", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parsea un array JSON de 1536 números devuelto en un bloque de texto", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        content: [{ type: "text", text: `Here you go:\n${JSON.stringify(VALID_VECTOR)}` }],
      }),
    );

    const result = await generateEmbedding("algún contenido", "sk-test", "claude-sonnet-5");

    expect(result).toHaveLength(1536);
    expect(result[0]).toBe(0.1);
  });

  it("rechaza cuando la respuesta trae menos de 1536 números", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ content: [{ type: "text", text: "[0.1, 0.2, 0.3]" }] }),
    );

    await expect(generateEmbedding("x", "sk-test")).rejects.toThrow(EmbeddingError);
  });

  it("rechaza cuando stop_reason es 'refusal'", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ stop_reason: "refusal", content: [] }));

    await expect(generateEmbedding("x", "sk-test")).rejects.toThrow(/refusal/);
  });

  it("rechaza cuando la API responde con un error HTTP", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: { message: "invalid x-api-key" } }, 401),
    );

    await expect(generateEmbedding("x", "sk-bad")).rejects.toThrow(/invalid x-api-key/);
  });

  it("rechaza cuando no hay ningún array JSON en el texto", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ content: [{ type: "text", text: "no puedo ayudar con eso" }] }),
    );

    await expect(generateEmbedding("x", "sk-test")).rejects.toThrow(EmbeddingError);
  });
});
