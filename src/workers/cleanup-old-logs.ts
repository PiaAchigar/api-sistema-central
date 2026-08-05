// api-sistema-central/src/workers/cleanup-old-logs.ts
//
// Limpieza semanal de logs de WhatsApp (Task 6 — confiabilidad WhatsApp).
// `delivery_logs` y `message_queue` (migración 1.21.0) no se guardan para
// siempre: después de 7 días ya no sirven para debug y solo ocupan espacio.
//
// En Supabase (producción) esto lo corre `pg_cron` directo en SQL — ver la
// sección "LIMPIEZA AUTOMÁTICA DE LOGS" en DOCUMENTACION_BD.md — no hace
// falta un Worker corriendo para eso. Esta función existe como equivalente
// TypeScript de esa misma limpieza: sirve para correrla a mano en local (sin
// pg_cron) o desde un endpoint/cron de Cloudflare si algún día se decide
// mover la limpieza acá en vez de dejarla en Supabase.
//
// Reglas (mismas que el SQL documentado):
//   - delivery_logs: se borra todo lo de 7+ días, sin excepción (es solo
//     auditoría de intentos de envío, no hace falta retenerlo).
//   - message_queue: solo se borra sent/failed/cancelled de 7+ días — los
//     mensajes "pending" NUNCA se tocan acá, sin importar la antigüedad,
//     porque siguen esperando ser procesados por queue-processor.ts.
import { and, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { deliveryLogs, messageQueue } from "../db/schema";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

export interface CleanupOldLogsResult {
  deliveryLogsDeleted: number;
  messageQueueDeleted: number;
}

export async function cleanupOldLogs(db: Db): Promise<CleanupOldLogsResult> {
  const cutoff = new Date(Date.now() - RETENTION_MS);

  const deletedLogs = await db
    .delete(deliveryLogs)
    .where(lt(deliveryLogs.createdAt, cutoff))
    .returning({ id: deliveryLogs.id });

  const deletedQueue = await db
    .delete(messageQueue)
    .where(
      and(
        lt(messageQueue.createdAt, cutoff),
        inArray(messageQueue.status, ["sent", "failed", "cancelled"]),
      ),
    )
    .returning({ id: messageQueue.id });

  return {
    deliveryLogsDeleted: deletedLogs.length,
    messageQueueDeleted: deletedQueue.length,
  };
}
