// api-sistema-central/src/services/rate-limiter.service.ts
//
// Rate limiting de envíos de WhatsApp (Task 4 — confiabilidad WhatsApp). Solo
// Postgres, sin Redis/Upstash ni ningún servicio externo — el plan
// (planning/ajustes_meta_crm.md) pide explícitamente "no requiere
// herramientas externas". La tabla `rate_limit_buckets` (migración 1.21.0,
// creada por Task 1 y reservada para esta task) guarda un contador por
// usuario por minuto ("fixed window counter"): una fila = un minuto de
// actividad de un usuario.
//
// No hay `db` global en este Worker — cada request crea su propia conexión
// vía Hyperdrive (ver db/client.ts) — por eso `db` se recibe como parámetro,
// igual que el resto de repos/servicios (ver delivery-logger.service.ts,
// message-queue.service.ts).
import { lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { rateLimitBuckets } from "../db/schema";

export type RateLimitType = "manual" | "automation";

const LIMITS: Record<RateLimitType, number> = {
  manual: 50, // msgs/min — envíos manuales de un agente (POST /crm/conversations/:id/messages)
  automation: 10, // msgs/min — automatizaciones (ver workers/queue-processor.ts, Task 2)
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/** UUID v1-v5 laxo (no valida el nibble de versión estrictamente) — alcanza
 *  para distinguir un `userId` real de `users.id` del pseudo-usuario
 *  `"api-key"` que asigna `middleware/auth.ts` cuando se autentica con
 *  `x-api-key` en vez de un JWT de Supabase (ver env.ts / auth.ts). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Clave del minuto actual en UTC, con precisión de minuto: "YYYY-MM-DD HH:mm".
 *  Usar UTC (no hora local del Worker) para que el bucket sea determinístico
 *  sin importar en qué datacenter de Cloudflare corra la request. */
function currentMinuteKey(now: Date): string {
  return now.toISOString().slice(0, 16).replace("T", " ");
}

/** Inicio del próximo minuto UTC — cuándo se resetea el bucket actual. */
function nextMinuteBoundary(now: Date): Date {
  const resetAt = new Date(now);
  resetAt.setUTCSeconds(0, 0);
  resetAt.setUTCMinutes(resetAt.getUTCMinutes() + 1);
  return resetAt;
}

/**
 * Chequea (e incrementa) el rate limit de un usuario para el minuto actual.
 * Límites: 50 msgs/min para envíos manuales, 10 msgs/min para automatizaciones.
 *
 * Implementación atómica: un solo `INSERT ... ON CONFLICT DO UPDATE SET
 * count = count + 1 RETURNING count` (mismo patrón que `upsertChannel` en
 * `channels.repo.ts`). El plan original proponía leer el bucket primero y
 * decidir en JS si crear o actualizar — eso tiene una race condition real: en
 * un Worker, requests concurrentes al mismo usuario podrían leer el mismo
 * `count` antes de que ninguna escriba, y las dos pasarían el chequeo. El
 * upsert atómico evita esa ventana por completo (Postgres serializa el
 * INSERT/UPDATE a nivel de fila).
 *
 * Efecto secundario: una request que termina bloqueada (count > limit)
 * también incrementa el contador. Es intencional — es el mismo trade-off que
 * cualquier "fixed window counter" atómico; no cambia si el usuario queda
 * bloqueado (una vez que count > limit, sigue > limit el resto del minuto),
 * solo hace que `remaining` reportado sea 0 en vez de negativo (se clampea).
 *
 * Caso especial `userId = "api-key"`: el middleware de auth (`auth.ts`)
 * asigna ese string fijo cuando la request se autentica con `x-api-key` en
 * vez de un JWT de Supabase — no es un UUID real de `users.id`, y la tabla
 * tiene `user_id UUID NOT NULL REFERENCES users(id)`, así que insertarlo
 * rompería (ni siquiera parsea como UUID). Ese caller es server-to-server de
 * confianza (no un agente humano tipeando mensajes), así que se deja pasar
 * sin contabilizar — ver Concerns en el reporte de esta task.
 */
export async function checkRateLimit(
  db: Db,
  userId: string,
  type: RateLimitType = "manual",
): Promise<RateLimitResult> {
  const limit = LIMITS[type];
  const now = new Date();
  const resetAt = nextMinuteBoundary(now);

  if (!UUID_RE.test(userId)) {
    // Pseudo-usuario (ej: "api-key") sin fila válida en `users` — no se puede
    // contabilizar sin violar la FK. Fail-open: se permite sin descontar.
    return { allowed: true, remaining: limit, resetAt };
  }

  const minuteKey = currentMinuteKey(now);

  const rows = await db
    .insert(rateLimitBuckets)
    .values({ userId, minuteKey, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.userId, rateLimitBuckets.minuteKey],
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    })
    .returning({ count: rateLimitBuckets.count });

  const count = rows[0]!.count;

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt,
  };
}

/** Borra buckets de hace más de 1 hora. Se llama desde el cron existente
 *  (`scheduled()` en index.ts, `"* * * * *"`, mismo trigger que
 *  `processMessageQueue` — Task 2) junto al resto de la limpieza de
 *  confiabilidad de WhatsApp; no amerita un cron propio. Barata: filtra por
 *  `idx_rate_limit_buckets_created` (migración 1.21.0). */
export async function cleanupOldBuckets(db: Db): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await db.delete(rateLimitBuckets).where(lt(rateLimitBuckets.createdAt, oneHourAgo));
}
