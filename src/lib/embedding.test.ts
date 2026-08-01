import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError, generateEmbedding } from "./embedding";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VALID_VECTOR = Array.from({ length: 1536 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1));

describe("generateEmbedding (OpenAI)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("devuelve un embedding de 1536 dimensiones desde OpenAI", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        data: [{ embedding: VALID_VECTOR }],
      }),
    );

    const result = await generateEmbedding("algún contenido", "sk-proj-test", "openai");

    expect(result).toHaveLength(1536);
    expect(result[0]).toBe(0.1);
  });

  it("rechaza cuando la respuesta trae menos de 1536 dimensiones", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    );

    await expect(generateEmbedding("x", "sk-proj-test", "openai")).rejects.toThrow(
      EmbeddingError,
    );
  });

  it("rechaza cuando la API responde con error HTTP", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: { message: "invalid api key" } }, 401),
    );

    await expect(generateEmbedding("x", "sk-proj-bad", "openai")).rejects.toThrow(
      /invalid api key/,
    );
  });

  it("rechaza cuando no está el array de embedding en la respuesta", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        data: [{}],
      }),
    );

    await expect(generateEmbedding("x", "sk-proj-test", "openai")).rejects.toThrow(
      EmbeddingError,
    );
  });

  it("rechaza cuando se intenta usar un provider no soportado", async () => {
    await expect(generateEmbedding("x", "sk-test", "anthropic")).rejects.toThrow(
      /no soportado/,
    );
  });
});
