import { z } from "zod";

/** Set fijo de canales, en orden de display. */
export const CHANNEL_TYPES = ["whatsapp", "instagram", "facebook", "email"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export function isChannelType(v: string): v is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(v);
}

// Config NO-secreta por canal. Todos los campos opcionales: se permite guardar
// parcial. Los secretos (tokens/passwords) NO viven acá (Fase 6).
const CONFIG_SCHEMAS = {
  whatsapp: z.object({
    phoneNumber: z.string().optional(),
    phoneNumberId: z.string().optional(),
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

/** Body del PUT para un canal dado: activo + su config tipada. */
export function putBodySchemaFor(ct: ChannelType) {
  return z.object({
    isActive: z.boolean(),
    config: CONFIG_SCHEMAS[ct],
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
