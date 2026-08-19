import { describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  createCredentialSchema,
  isAIProvider,
  validateApiKeySchema,
} from "./ai-config.schema";

describe("isAIProvider", () => {
  it("acepta los proveedores soportados", () => {
    expect(AI_PROVIDERS.every((p) => isAIProvider(p))).toBe(true);
  });
  it("rechaza un proveedor desconocido", () => {
    expect(isAIProvider("gemini")).toBe(false);
  });
});

describe("createCredentialSchema", () => {
  it("acepta un body válido", () => {
    const r = createCredentialSchema.safeParse({
      provider: "anthropic",
      api_key: "sk-ant-123",
      model: "claude-3-5-sonnet",
    });
    expect(r.success).toBe(true);
  });
  it("rechaza provider desconocido", () => {
    const r = createCredentialSchema.safeParse({
      provider: "gemini",
      api_key: "k",
      model: "m",
    });
    expect(r.success).toBe(false);
  });
  it("rechaza api_key vacía", () => {
    const r = createCredentialSchema.safeParse({
      provider: "anthropic",
      api_key: "",
      model: "claude-3-5-sonnet",
    });
    expect(r.success).toBe(false);
  });
  it("rechaza model vacío", () => {
    const r = createCredentialSchema.safeParse({
      provider: "anthropic",
      api_key: "sk-ant-123",
      model: "",
    });
    expect(r.success).toBe(false);
  });
  it("rechaza si falta api_key", () => {
    const r = createCredentialSchema.safeParse({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(r.success).toBe(false);
  });
  it("acepta openai con el modelo fijo text-embedding-3-small", () => {
    const r = createCredentialSchema.safeParse({
      provider: "openai",
      api_key: "sk-123",
      model: "text-embedding-3-small",
    });
    expect(r.success).toBe(true);
  });
  it("rechaza openai con cualquier otro modelo (evita mezclar espacios de embeddings)", () => {
    const r = createCredentialSchema.safeParse({
      provider: "openai",
      api_key: "sk-123",
      model: "text-embedding-3-large",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toContain("text-embedding-3-small");
    }
  });
});

describe("validateApiKeySchema", () => {
  it("acepta un body válido", () => {
    const r = validateApiKeySchema.safeParse({
      provider: "openai",
      api_key: "sk-123",
      model: "gpt-4o",
    });
    expect(r.success).toBe(true);
  });
  it("rechaza body inválido (bad key vacía)", () => {
    const r = validateApiKeySchema.safeParse({
      provider: "anthropic",
      api_key: "",
      model: "claude-3-5-sonnet",
    });
    expect(r.success).toBe(false);
  });
});
