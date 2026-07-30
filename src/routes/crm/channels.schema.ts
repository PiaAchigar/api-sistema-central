import { z } from "zod";

/** Set fijo de canales, en orden de display. */
export const CHANNEL_TYPES = ["whatsapp", "instagram", "facebook", "email"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export function isChannelType(v: string): v is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(v);
}

// Config NO-secreta por canal. Todos los campos opcionales: se permite guardar
// parcial. Los secretos (tokens/passwords) viven en CREDENTIALS_SCHEMAS.
const CONFIG_SCHEMAS = {
  whatsapp: z.object({
    phoneNumber: z.string().optional(),
  }),
  instagram: z.object({
    accountId: z.string().optional(),
    handle: z.string().optional(),
  }),
  facebook: z.object({
    pageId: z.string().optional(),
    pageName: z.string().optional(),
  }),
  email: z.object({
    fromAddress: z.string().optional(),
    smtpHost: z.string().optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
  }),
} as const;

// Credenciales secretas por canal (se encriptan antes de guardar, nunca se
// devuelven). Todo-o-nada: si se manda `credentials`, deben venir completas.
// Los canales sin entrada acá todavía no tienen integración real (Fase 6 v1
// es solo WhatsApp) — para esos, el body no acepta `credentials`.
const CREDENTIALS_SCHEMAS = {
  whatsapp: z.object({
    accessToken: z.string().min(1),
    phoneNumberId: z.string().min(1),
    appSecret: z.string().min(1),
    verifyToken: z.string().min(1),
  }),
} as const;

type CredentialsChannelType = keyof typeof CREDENTIALS_SCHEMAS;

function hasCredentialsSchema(ct: ChannelType): ct is CredentialsChannelType {
  return ct in CREDENTIALS_SCHEMAS;
}

/** Body del PUT para un canal dado: activo + su config tipada + (si aplica)
 *  sus credenciales. Omitir `credentials` deja las ya guardadas sin tocar. */
export function putBodySchemaFor(ct: ChannelType) {
  return z.object({
    isActive: z.boolean(),
    config: CONFIG_SCHEMAS[ct],
    credentials: hasCredentialsSchema(ct) ? CREDENTIALS_SCHEMAS[ct].optional() : z.undefined(),
  });
}

/** Campo cuya presencia marca al canal como "configurado". */
const REQUIRED_FIELD: Record<ChannelType, string> = {
  whatsapp: "phoneNumber",
  instagram: "accountId",
  facebook: "pageId",
  email: "fromAddress",
};

export type ChannelStatus = "sin_configurar" | "inactivo" | "activo";

/** Estado derivado (NO verificado contra el canal real — eso es Fase 6). */
export function deriveStatus(
  ct: ChannelType,
  config: Record<string, unknown> | null | undefined,
  isActive: boolean | null | undefined,
): ChannelStatus {
  const val = config?.[REQUIRED_FIELD[ct]];
  const configured = typeof val === "string" ? val.trim() !== "" : val != null;
  if (!configured) return "sin_configurar";
  return isActive ? "activo" : "inactivo";
}
