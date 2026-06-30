import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, requireAdmin } from "../middleware/auth";
import {
  createUser,
  deleteUser,
  listUsers,
  requireSupabaseAdmin,
  updateUserRole,
} from "../lib/supabase-admin";
import type { AppBindings, Variables } from "../env";
import { createDb } from "../db/client";
import { setLocalUserActive, setLocalUserRole, upsertLocalUser } from "../repositories/users.repo";

const ROLES = ["admin", "manager", "operator", "sales", "accountant"] as const;

const usersRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

usersRouter.use("*", requireAuth, requireAdmin);

usersRouter.get("/", async (c) => {
  const cfg = requireSupabaseAdmin(c.env);
  return c.json(await listUsers(cfg));
});

usersRouter.post(
  "/",
  zValidator(
    "json",
    z.object({
      email: z.string().email(),
      password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
      role: z.enum(ROLES),
    }),
  ),
  async (c) => {
    const cfg = requireSupabaseAdmin(c.env);
    const body = c.req.valid("json");
    const created = await createUser(cfg, body);
    const db = createDb(c.env);
    await upsertLocalUser(db, { authId: created.id, email: created.email ?? body.email, role: body.role });
    return c.json(created, 201);
  },
);

usersRouter.patch(
  "/:id",
  zValidator("json", z.object({ role: z.enum(ROLES) })),
  async (c) => {
    const cfg = requireSupabaseAdmin(c.env);
    const id = c.req.param("id");
    if (id === c.get("userId")) {
      throw new AppError(400, "No podés cambiar tu propio rol.");
    }
    const updated = await updateUserRole(cfg, id, c.req.valid("json").role);
    const db = createDb(c.env);
    await setLocalUserRole(db, id, c.req.valid("json").role);
    return c.json(updated);
  },
);

usersRouter.delete("/:id", async (c) => {
  const cfg = requireSupabaseAdmin(c.env);
  const id = c.req.param("id");
  if (id === c.get("userId")) {
    throw new AppError(400, "No podés eliminar tu propio usuario.");
  }
  await deleteUser(cfg, id);
  const db = createDb(c.env);
  await setLocalUserActive(db, id, false);
  return c.json({ ok: true });
});

export { usersRouter };
