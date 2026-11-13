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
import {
  fullNamesByAuthId,
  setLocalUserActive,
  setLocalUserFullName,
  setLocalUserRole,
  upsertLocalUser,
} from "../repositories/users.repo";

const ROLES = ["admin", "manager", "operator", "sales", "accountant"] as const;

const fullNameSchema = z
  .string()
  .trim()
  .min(1, "El nombre es obligatorio")
  .max(100, "El nombre no puede pasar los 100 caracteres");

const usersRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

usersRouter.use("*", requireAuth, requireAdmin);

usersRouter.get("/", async (c) => {
  const cfg = requireSupabaseAdmin(c.env);
  const list = await listUsers(cfg);
  const names = await fullNamesByAuthId(
    createDb(c.env),
    list.map((u) => u.id),
  );
  return c.json(list.map((u) => ({ ...u, fullName: names.get(u.id) ?? null })));
});

usersRouter.post(
  "/",
  zValidator(
    "json",
    z.object({
      fullName: fullNameSchema,
      email: z.string().email(),
      password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
      role: z.enum(ROLES),
    }),
  ),
  async (c) => {
    const cfg = requireSupabaseAdmin(c.env);
    const body = c.req.valid("json");
    const { fullName, ...authData } = body;
    const created = await createUser(cfg, authData);
    const db = createDb(c.env);
    await upsertLocalUser(db, { authId: created.id, email: created.email ?? body.email, role: body.role, fullName });
    return c.json({ ...created, fullName }, 201);
  },
);

usersRouter.patch(
  "/:authId/nombre",
  zValidator("json", z.object({ fullName: fullNameSchema })),
  async (c) => {
    const { fullName } = c.req.valid("json");
    const authId = c.req.param("authId");
    if (!z.string().uuid().safeParse(authId).success) {
      throw new AppError(404, "Usuario no encontrado.");
    }
    const ok = await setLocalUserFullName(createDb(c.env), authId, fullName);
    if (!ok) throw new AppError(404, "Usuario no encontrado.");
    return c.json({ ok: true, fullName });
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
