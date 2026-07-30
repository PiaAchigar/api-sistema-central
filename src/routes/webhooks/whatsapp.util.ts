import { z } from "zod";

const handshakeQuerySchema = z.object({
  "hub.mode": z.literal("subscribe"),
  "hub.verify_token": z.string(),
  "hub.challenge": z.string(),
});

/** Parsea los query params del handshake GET de Meta. Null si falta algo o
 *  hub.mode no es "subscribe" (lo demás lo valida el caller contra el
 *  verify_token guardado). */
export function parseHandshakeQuery(
  query: Record<string, string | undefined>,
): { "hub.mode": "subscribe"; "hub.verify_token": string; "hub.challenge": string } | null {
  const parsed = handshakeQuerySchema.safeParse(query);
  return parsed.success ? parsed.data : null;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Comparación en tiempo constante (por longitud de string) para no filtrar
 *  la firma esperada por timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verifica el header X-Hub-Signature-256 (HMAC-SHA256 del body crudo con el
 *  appSecret de la credencial de WhatsApp guardada) contra el body recibido. */
export async function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expectedHex = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody) as BufferSource,
  );
  return timingSafeEqual(toHex(new Uint8Array(sigBuf)), expectedHex);
}

const webhookPayloadSchema = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            messages: z
              .array(
                z.object({
                  from: z.string(),
                  id: z.string(),
                  type: z.string(),
                  text: z.object({ body: z.string() }).optional(),
                }),
              )
              .optional(),
          }),
        }),
      ),
    }),
  ),
});

/** Extrae {from, waId, text} de TODOS los mensajes de texto del payload de
 *  Meta — recorre entry[] → changes[] → value.messages[], porque Meta puede
 *  batchear varios mensajes en un solo webhook call. Array vacío si el
 *  payload no tiene la forma esperada, no trae `messages` (ej. un callback de
 *  status/delivery), o ninguno de los mensajes es de tipo texto. */
export function extractIncomingMessage(
  payload: unknown,
): { from: string; waId: string; text: string }[] {
  const parsed = webhookPayloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  const out: { from: string; waId: string; text: string }[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      for (const msg of change.value.messages ?? []) {
        if (msg.type === "text" && msg.text) {
          out.push({ from: msg.from, waId: msg.id, text: msg.text.body });
        }
      }
    }
  }
  return out;
}
