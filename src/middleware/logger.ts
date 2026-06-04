import { createMiddleware } from "hono/factory";
import type { AppBindings, Variables } from "../env";

export const requestLogger = createMiddleware<{
  Bindings: AppBindings;
  Variables: Variables;
}>(
  async (c, next) => {
    const start = Date.now();
    const { method, path } = c.req;

    await next();

    const ms = Date.now() - start;
    const status = c.res.status;
    console.log(`[${new Date().toISOString()}] ${method} ${path} -> ${status} (${ms}ms)`);
  },
);
