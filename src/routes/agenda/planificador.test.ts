import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppBindings, Variables } from "../../env";

// Las rutas piden sesión: se reemplaza `auth` por uno que toma el usuario de x-user.
vi.mock("../../middleware/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../middleware/auth")>();
  return {
    ...real,
    auth: async (c: any, next: any) => {
      const user = c.req.header("x-user") ?? null;
      c.set("userId", user);
      c.set("userRole", user ? "admin" : null);
      await next();
    },
  };
});

const { auth } = await import("../../middleware/auth");
const { planificadorRouter } = await import("./planificador");

const URL_DB = "postgresql://piubella:piubella@localhost:5499/piubella";
const ENV = { HYPERDRIVE: { connectionString: URL_DB } } as unknown as AppBindings;

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.use("*", auth);
app.route("/api/agenda/planificador", planificadorRouter);

const get = (id: string, user?: string) =>
  app.request(`/api/agenda/planificador/${id}`, { headers: user ? { "x-user": user } : {} }, ENV);

describe("GET /api/agenda/planificador/:compraId", () => {
  it("401 sin sesión", async () => {
    expect((await get("00000000-0000-0000-0000-000000000000")).status).toBe(401);
  });

  it("404 si la compra no existe", async () => {
    const res = await get("00000000-0000-0000-0000-000000000000", "u-test");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "La compra no existe" });
    // Un id que ni siquiera es uuid tampoco es un 500.
    expect((await get("no-es-un-uuid", "u-test")).status).toBe(404);
  });
});
