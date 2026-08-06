import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodSchema, ZodError } from "zod";

/**
 * Aplana un ZodError a una sola línea legible por una persona:
 *   "activityId must be a valid UUID; monthlyAmount es requerido"
 *
 * El `path` se antepone solo cuando el mensaje no lo nombra ya, para no
 * repetirlo ("activityId: activityId must be a valid UUID").
 */
function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      if (!path || issue.message.includes(path)) return issue.message;
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * zValidator con el error aplanado a string.
 *
 * El hook por defecto de @hono/zod-validator responde
 *     { success: false, error: <ZodError crudo> }
 * — `error` como OBJETO. El front hace `body.error` y lo muestra tal cual, así
 * que al usuario le aparece literalmente "[object Object]" en pantalla en vez
 * del motivo del rechazo. Esta variante mantiene el contrato
 * { success, data?, error? } con `error` siempre string, igual que el resto de
 * las respuestas de la API y que app.onError.
 */
export function zv<T extends ZodSchema, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json({ success: false, error: formatZodError(result.error) }, 400);
    }
    return undefined;
  });
}
