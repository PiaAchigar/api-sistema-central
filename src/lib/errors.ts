import { HTTPException } from "hono/http-exception";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;

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

export const internal = (message = "Internal server error", cause?: unknown) =>
  new AppError(500, message, cause);
