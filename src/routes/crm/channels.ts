// api-sistema-central/src/routes/crm/channels.ts
import { Hono } from "hono";
import { createDb } from "../../db/client";
import { badRequest } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import { listChannels, upsertChannel } from "../../repositories/channels.repo";
import {
  CHANNEL_TYPES,
  deriveStatus,
  isChannelType,
  putBodySchemaFor,
  type ChannelType,
} from "./channels.schema";
import type { AppBindings, Variables } from "../../env";

const channelsRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

/** Forma unificada de respuesta (GET y PUT), con `status` recalculado. */
function toResponse(
  ct: ChannelType,
  row:
    | { configJson: unknown; isActive: boolean | null; updatedAt: Date | null }
    | undefined,
) {
  const config = (row?.configJson as Record<string, unknown> | null) ?? {};
  const isActive = row?.isActive ?? false;
  return {
    channelType: ct,
    isActive,
    config,
    status: deriveStatus(ct, config, isActive),
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

// Siempre devuelve los 4 canales: mergea el set fijo con lo guardado. Un canal
// sin fila sale como sin_configurar / isActive=false / config vacía.
channelsRouter.get("/", requireAuth, requirePermission("crm", "view"), async (c) => {
  const db = createDb(c.env);
  const rows = await listChannels(db);
  const byType = new Map(rows.map((r) => [r.channelType, r] as const));
  return c.json(CHANNEL_TYPES.map((ct) => toResponse(ct, byType.get(ct))));
});

// Editar = solo admin (crm:manage). Valida el canal del path y la config del body.
channelsRouter.put(
  "/:channelType",
  requireAuth,
  requirePermission("crm", "manage"),
  async (c) => {
    const ct = c.req.param("channelType");
    if (!isChannelType(ct)) throw badRequest("Canal desconocido");
    const body = await c.req.json().catch(() => null);
    const parsed = putBodySchemaFor(ct).safeParse(body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? "Config inválida");
    }
    const db = createDb(c.env);
    const row = await upsertChannel(db, ct, {
      config: parsed.data.config,
      isActive: parsed.data.isActive,
    });
    return c.json(toResponse(ct, row));
  },
);

export { channelsRouter };
