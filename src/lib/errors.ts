import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;

export class AppError extends HTTPException {
  constructor(status: ErrorStatus, message: string, cause?: unknown) {
    super(status, { message, cause });
    this.name = "AppError";
  }
}

export const notFound = (resource = "Resource") =>
  new AppError(404, `${resource} not found`);

export const badRequest = (message = "Bad request", cause?: unknown) =>
  new AppError(400, message, cause);

export const unauthorized = (message = "Unauthorized") =>
  new AppError(401, message);

export const conflict = (message = "Conflict") => new AppError(409, message);

export const unprocessable = (message = "Unprocessable entity") =>
  new AppError(422, message);

export const internal = (message = "Internal server error", cause?: unknown) =>
  new AppError(500, message, cause);

export const badGateway = (message = "Upstream error", cause?: unknown) =>
  new AppError(502, message, cause);

/** Igual que AppError pero con status arbitrario (no limitado a ErrorStatus).
 *  Existe para preservar el código HTTP real que devuelve una API externa
 *  (ej. Meta Graph API: 429 rate limit, 403 forbidden, 500 upstream error)
 *  en vez de colapsarlo siempre a 502 vía badGateway(). httpStatusOf() en
 *  whatsapp-retry.service.ts lee `err.status` — con esto graba el código
 *  real en delivery_logs.meta_error_code en vez de 502 fijo. */
export class UpstreamError extends HTTPException {
  constructor(status: number, message: string, cause?: unknown) {
    // El parámetro es `number` (no ErrorStatus) a propósito: acá entra
    // cualquier status HTTP real que devuelva una API externa (Meta puede
    // responder con códigos fuera de nuestro ErrorStatus acotado, ej. 413,
    // 451). Hono tipa HTTPException con ContentfulStatusCode — casteamos
    // porque los códigos que llegan acá siempre son códigos HTTP válidos.
    super(status as ContentfulStatusCode, { message, cause });
    this.name = "UpstreamError";
  }
}

export const upstreamError = (status: number, message = "Upstream error", cause?: unknown) =>
  new UpstreamError(status, message, cause);
