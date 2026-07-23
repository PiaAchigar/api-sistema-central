import { PostgresError } from "postgres";

/** Código SQLSTATE de "foreign_key_violation". */
const FK_VIOLATION = "23503";

/** true si el error viene de Postgres y es una violación de FK (ej: se intentó
 *  borrar un registro referenciado por otra tabla). Se usa para distinguir esto
 *  de otros errores de DB y devolver un mensaje amigable en vez de un 500. */
export function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof PostgresError && err.code === FK_VIOLATION;
}
