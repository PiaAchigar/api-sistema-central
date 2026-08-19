import { z } from "zod";
import { DEFAULT_OPENAI_MODEL } from "../lib/embedding";

/** Proveedores soportados. Agregar acá + en `MODEL_TEST_ENDPOINTS` (ai-config.ts)
 *  cuando se sume uno nuevo. */
export const AI_PROVIDERS = ["anthropic", "openai"] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

export function isAIProvider(v: string): v is AIProvider {
  return (AI_PROVIDERS as readonly string[]).includes(v);
}

export const createCredentialSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS),
    api_key: z.string().min(1, "api_key es requerida"),
    model: z.string().min(1, "model es requerido"),
  })
  .superRefine((data, ctx) => {
    // Único constraint duro del plan: la columna de embeddings guarda
    // vectores de 1536 dimensiones y `text-embedding-3-small` es el único
    // modelo de OpenAI que las produce con los parámetros que usa
    // `generateOpenAIEmbedding`. Guardar otro modelo escribiría vectores de
    // un espacio distinto en la misma columna sin que nada lo detecte.
    if (data.provider === "openai" && data.model !== DEFAULT_OPENAI_MODEL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: `El modelo para OpenAI tiene que ser "${DEFAULT_OPENAI_MODEL}".`,
      });
    }
  });
export type CreateCredentialBody = z.infer<typeof createCredentialSchema>;

export const validateApiKeySchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  api_key: z.string().min(1, "api_key es requerida"),
  model: z.string().min(1, "model es requerido"),
});
export type ValidateApiKeyBody = z.infer<typeof validateApiKeySchema>;
