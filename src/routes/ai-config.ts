// api-sistema-central/src/routes/ai-config.ts
//
// Credenciales de proveedores de IA (Anthropic, OpenAI) que Laura carga desde
// el CRM para que otros sistemas (cloud function RAG, script Python, chatbot
// n8n) las consuman. La api_key se cifra (AES-GCM) antes de guardarse y nunca
// se devuelve en una respuesta HTTP — ni siquiera a `/credentials` (GET).
import { Hono } from "hono";
import { badRequest, notFound } from "../lib/errors";
import { requireAuth, requirePermission } from "../middleware/auth";
import {
  createAICredential,
  deactivateAICredential,
  listAICredentials,
} from "../repositories/ai-credentials.repo";
import { createDb } from "../db/client";
import { encrypt } from "../services/crypto.service";
import {
  createCredentialSchema,
  validateApiKeySchema,
  type AIProvider,
} from "./ai-config.schema";
import type { AppBindings, Variables } from "../env";

const aiConfigRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

function toResponse(row: {
  id: string;
  provider: string | null;
  model: string | null;
  isActive: boolean | null;
  createdAt: Date | null;
}) {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    is_active: row.isActive ?? false,
    created_at: row.createdAt ? row.createdAt.toISOString() : null,
  };
}

/** Resultado de probar la key contra el proveedor real. */
type ValidationResult = { valid: boolean; error?: string };

async function testAnthropicKey(apiKey: string, model: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 10,
        messages: [{ role: "user", content: "test" }],
      }),
    });
    if (res.ok) return { valid: true };
    const body = await res.json().catch(() => null);
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      `Anthropic respondió ${res.status}`;
    return { valid: false, error: message };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : "Error de red" };
  }
}

async function testOpenAIKey(apiKey: string, model: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: "test",
      }),
    });
    if (res.ok) return { valid: true };
    const body = await res.json().catch(() => null);
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      `OpenAI respondió ${res.status}`;
    return { valid: false, error: message };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : "Error de red" };
  }
}

const VALIDATORS: Record<AIProvider, (apiKey: string, model: string) => Promise<ValidationResult>> =
  {
    anthropic: testAnthropicKey,
    openai: testOpenAIKey,
  };

// Lista credenciales guardadas (sin api_key). Cualquiera con acceso de
// lectura al CRM puede ver qué hay configurado.
aiConfigRouter.get("/credentials", requireAuth, requirePermission("crm", "view"), async (c) => {
  const db = createDb(c.env);
  const rows = await listAICredentials(db);
  return c.json(rows.map(toResponse));
});

// Guarda una credencial nueva: cifra la api_key y desactiva cualquier otra
// del mismo proveedor (solo una activa a la vez, ver índice único en la
// migración). No valida contra el proveedor acá — el frontend llama primero
// a /validate y recién si eso da ok manda el POST a /credentials.
aiConfigRouter.post("/credentials", requireAuth, requirePermission("crm", "manage"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createCredentialSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? "Credencial inválida");
  }
  const db = createDb(c.env);
  const encryptedApiKey = await encrypt(parsed.data.api_key, c.env.CREDENTIALS_ENCRYPTION_KEY);
  const row = await createAICredential(db, {
    provider: parsed.data.provider,
    encryptedApiKey,
    model: parsed.data.model,
  });
  return c.json(toResponse(row), 201);
});

// Prueba la api_key contra el proveedor real (request mínima, max_tokens=10)
// SIN guardar nada. El frontend usa esto antes de guardar la credencial.
aiConfigRouter.post("/validate", requireAuth, requirePermission("crm", "manage"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = validateApiKeySchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? "Datos inválidos");
  }
  const result = await VALIDATORS[parsed.data.provider](parsed.data.api_key, parsed.data.model);
  return c.json(result);
});

// Desactiva una credencial (no la borra: queda como histórico con
// is_active=false).
aiConfigRouter.patch(
  "/credentials/:id/deactivate",
  requireAuth,
  requirePermission("crm", "manage"),
  async (c) => {
    const id = c.req.param("id");
    const db = createDb(c.env);
    const row = await deactivateAICredential(db, id);
    if (!row) throw notFound("Credencial");
    return c.json(toResponse(row));
  },
);

export { aiConfigRouter };
