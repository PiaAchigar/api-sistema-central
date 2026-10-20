import postgres from "postgres";

/** Código SQLSTATE de "foreign_key_violation". */
const FK_VIOLATION = "23503";

/** true si el error viene de Postgres y es una violación de FK (ej: se intentó
 *  borrar un registro referenciado por otra tabla). Se usa para distinguir esto
 *  de otros errores de DB y devolver un mensaje amigable en vez de un 500. */
export function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof postgres.PostgresError && err.code === FK_VIOLATION;
}

/**
 * ¿Es este error una violación de un índice UNIQUE (SQLSTATE 23505)?
 * postgres.js expone el SQLSTATE en `.code` y el nombre del índice en
 * `.constraint_name`; Drizzle a veces los envuelve en `.cause`. Con `constraintName`
 * se exige además ese índice, para no confundir uno distinto de la misma tabla.
 */
export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown; cause?: { code?: unknown; constraint_name?: unknown } };
  const code = e.code ?? e.cause?.code;
  const nombre = e.constraint_name ?? e.cause?.constraint_name;
  return code === "23505" && (constraintName === undefined || nombre === constraintName);
}
