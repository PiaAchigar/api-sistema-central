import { z } from "zod";

/** Proveedores soportados. Agregar acá + en `MODEL_TEST_ENDPOINTS` (ai-config.ts)
 *  cuando se sume uno nuevo. */
export const AI_PROVIDERS = ["anthropic", "openai"] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

export function isAIProvider(v: string): v is AIProvider {
  return (AI_PROVIDERS as readonly string[]).includes(v);
}

export const createCredentialSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  api_key: z.string().min(1, "api_key es requerida"),
  model: z.string().min(1, "model es requerido"),
});
export type CreateCredentialBody = z.infer<typeof createCredentialSchema>;

export const validateApiKeySchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  api_key: z.string().min(1, "api_key es requerida"),
  model: z.string().min(1, "model es requerido"),
});
export type ValidateApiKeyBody = z.infer<typeof validateApiKeySchema>;
