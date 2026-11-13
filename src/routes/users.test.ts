import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { users } from "../db/schema";
import type { Db } from "../db/client";
import type { AppBindings, Variables } from "../env";
import { listActiveLocalUsers } from "../repositories/users.repo";

const supa = vi.hoisted(() => ({
  createUser: vi.fn(),
  listUsers: vi.fn(),
}));
vi.mock("../lib/supabase-admin", () => ({
  requireSupabaseAdmin: () => ({ url: "x", serviceRoleKey: "y" }),
  createUser: supa.createUser,
  listUsers: supa.listUsers,
  updateUserRole: vi.fn(),
  deleteUser: vi.fn(),
}));

import { usersRouter } from "./users";

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;
const ENV = { HYPERDRIVE: { connectionString: LOCAL_DB_URL } } as unknown as AppBindings;

const QA = "zz_qa_nombre_";
const A1 = "00000000-0000-4000-8000-0000000000a1";
const A2 = "00000000-0000-4000-8000-0000000000a2";

function appCon(role: string | null) {
  const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
  app.onError((err, c) => {
    if ("status" in err && typeof err.status === "number") {
      return c.json({ error: err.message }, err.status as 400 | 404);
    }
    return c.json({ error: "Internal server error" }, 500);
  });
  app.use("*", async (c, next) => {
    c.set("userId", role ? "admin-test" : null);
    c.set("userRole", role);
    c.set("userEmail", null);
    await next();
  });
  app.route("/", usersRouter);
  return app;
}

function pedir(role: string | null, method: string, path: string, body?: unknown) {
  return appCon(role).request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV,
  );
}

async function limpiar() {
  await db.delete(users).where(like(users.email, `${QA}%`));
}

beforeEach(async () => {
  supa.createUser.mockReset();
  supa.listUsers.mockReset();
  await limpiar();
});
afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("POST /users", () => {
  const base = { email: `${QA}a@x.com`, password: "12345678", role: "sales" };

  it("exige fullName", async () => {
    const r = await pedir("admin", "POST", "/", base);
    expect(r.status).toBe(400);
    expect(supa.createUser).not.toHaveBeenCalled();
  });

  it("rechaza nombre vacío (tras trim) o de más de 100 caracteres", async () => {
    expect((await pedir("admin", "POST", "/", { ...base, fullName: "   " })).status).toBe(400);
    expect(
      (await pedir("admin", "POST", "/", { ...base, fullName: "x".repeat(101) })).status,
    ).toBe(400);
  });

  it("guarda el nombre recortado en users.full_name", async () => {
    supa.createUser.mockResolvedValue({ id: A1, email: base.email, role: "sales" });
    const r = await pedir("admin", "POST", "/", { ...base, fullName: "  Laura  " });
    expect(r.status).toBe(201);
    const [row] = await db.select().from(users).where(eq(users.authId, A1));
    expect(row.fullName).toBe("Laura");
    expect(supa.createUser.mock.calls[0][1]).not.toHaveProperty("fullName");
  });

  it("guarda quién lo creó si el admin tiene fila local, y NULL si no", async () => {
    // el pedido llega con userId "admin-test" (no es uuid): sin fila local
    supa.createUser.mockResolvedValue({ id: A1, email: base.email, role: "sales" });
    await pedir("admin", "POST", "/", { ...base, fullName: "Laura" });
    const [sin] = await db.select().from(users).where(eq(users.authId, A1));
    expect(sin.createdByUserId).toBeNull();

    const [admin] = await db
      .insert(users)
      .values({ authId: A2, email: `${QA}admin@x.com`, fullName: "Lucía Celano", role: "admin", isActive: true })
      .returning();
    const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
    app.use("*", async (c, next) => {
      c.set("userId", A2);
      c.set("userRole", "admin");
      c.set("userEmail", null);
      await next();
    });
    app.route("/", usersRouter);
    await db.delete(users).where(eq(users.authId, A1));
    const r = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...base, fullName: "Rosa" }),
      },
      ENV,
    );
    expect(r.status).toBe(201);
    const [con] = await db.select().from(users).where(eq(users.authId, A1));
    expect(con.createdByUserId).toBe(admin.id);

    supa.listUsers.mockResolvedValue([
      { id: A1, email: base.email, role: "sales", createdAt: null, lastSignInAt: null },
      { id: A2, email: `${QA}admin@x.com`, role: "admin", createdAt: null, lastSignInAt: null },
    ]);
    const lista = (await (await app.request("/", {}, ENV)).json()) as {
      id: string;
      createdByName: string | null;
    }[];
    expect(lista.find((u) => u.id === A1)?.createdByName).toBe("Lucía Ce.");
    expect(lista.find((u) => u.id === A2)?.createdByName).toBeNull();
  });

  it("es sólo para admin", async () => {
    expect((await pedir("manager", "POST", "/", { ...base, fullName: "L" })).status).toBe(403);
    expect((await pedir(null, "POST", "/", { ...base, fullName: "L" })).status).toBe(401);
  });
});

describe("PATCH /users/:authId/nombre", () => {
  it("actualiza el nombre", async () => {
    await db.insert(users).values({ authId: A1, email: `${QA}b@x.com`, role: "sales", isActive: true });
    const r = await pedir("admin", "PATCH", `/${A1}/nombre`, { fullName: " Ana " });
    expect(r.status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.authId, A1));
    expect(row.fullName).toBe("Ana");
  });

  it("404 si no hay fila local", async () => {
    const r = await pedir("admin", "PATCH", `/${A2}/nombre`, { fullName: "Ana" });
    expect(r.status).toBe(404);
  });

  it("400 con nombre inválido y 403 sin ser admin", async () => {
    expect((await pedir("admin", "PATCH", `/${A1}/nombre`, { fullName: "" })).status).toBe(400);
    expect((await pedir("sales", "PATCH", `/${A1}/nombre`, { fullName: "Ana" })).status).toBe(403);
  });
});

describe("GET /users", () => {
  it("incluye fullName de la fila local", async () => {
    await db.insert(users).values({ authId: A1, email: `${QA}c@x.com`, fullName: "Rosa", isActive: true });
    supa.listUsers.mockResolvedValue([
      { id: A1, email: `${QA}c@x.com`, role: "sales", createdAt: null, lastSignInAt: null },
      { id: A2, email: `${QA}d@x.com`, role: "sales", createdAt: null, lastSignInAt: null },
    ]);
    const r = await pedir("admin", "GET", "/");
    const body = (await r.json()) as { id: string; fullName: string | null }[];
    expect(body.find((u) => u.id === A1)?.fullName).toBe("Rosa");
    expect(body.find((u) => u.id === A2)?.fullName).toBeNull();
  });
});

describe("listActiveLocalUsers", () => {
  it("sólo activos con auth_id, ordenados por nombre", async () => {
    await db.insert(users).values([
      { authId: A1, email: `${QA}z@x.com`, fullName: "Zoe", isActive: true },
      { authId: A2, email: `${QA}m@x.com`, fullName: "Ana", isActive: true },
      { authId: null, email: `${QA}sin@x.com`, fullName: "Sin auth", isActive: true },
      { authId: "00000000-0000-4000-8000-0000000000a3", email: `${QA}off@x.com`, fullName: "Off", isActive: false },
    ]);
    const mios = (await listActiveLocalUsers(db)).filter((u) => u.email?.startsWith(QA));
    expect(mios.map((u) => u.fullName)).toEqual(["Ana", "Zoe"]);
  });
});

describe("GET /api/crm/deals/agents", () => {
  it("agrega nombreCorto sin perder fullName ni email", async () => {
    const { dealsRouter } = await import("./crm/deals");
    await db.insert(users).values({ authId: A1, email: `${QA}ag@x.com`, fullName: "Agostina Ríos", isActive: true });
    const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
    app.use("*", async (c, next) => {
      c.set("userId", "t");
      c.set("userRole", "admin");
      c.set("userEmail", null);
      await next();
    });
    app.route("/", dealsRouter);
    const r = await app.request("/agents", {}, ENV);
    const lista = (await r.json()) as { fullName: string; email: string; nombreCorto: string }[];
    const mio = lista.find((a) => a.email === `${QA}ag@x.com`);
    expect(mio).toMatchObject({ fullName: "Agostina Ríos", nombreCorto: "Agostina Rí." });
  });
});
