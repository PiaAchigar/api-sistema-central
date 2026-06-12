import type { MiddlewareHandler } from "hono";
import type { AppBindings, Variables } from "../env";

/**
 * v1 sin autenticación: passthrough que deja el gancho listo.
 * v2: validar JWT del header Authorization contra la tabla USERS
 * y setear c.set("userId", ...) con el usuario real.
 */
export const auth: MiddlewareHandler<{
  Bindings: AppBindings;
  Variables: Variables;
}> = async (c, next) => {
  c.set("userId", null);
  await next();
};
