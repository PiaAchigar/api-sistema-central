import type { MiddlewareHandler } from "hono";
import type { AppBindings, Variables } from "../env";

type HonoCtx = { Bindings: AppBindings; Variables: Variables };

async function verifySupabaseJWT(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const sig = Uint8Array.from(
      atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")),
      (ch) => ch.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sig,
      enc.encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(
      atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")),
    ) as Record<string, unknown>;

    if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** Extrae userId y userRole del token si es válido. No bloquea si falta. */
export const auth: MiddlewareHandler<HonoCtx> = async (c, next) => {
  c.set("userId", null);
  c.set("userRole", null);

  const authHeader = c.req.header("Authorization");
  if (c.env.SUPABASE_JWT_SECRET && authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = await verifySupabaseJWT(token, c.env.SUPABASE_JWT_SECRET);
    if (payload) {
      c.set("userId", (payload.sub as string) ?? null);
      const meta = payload.user_metadata as { role?: string } | undefined;
      c.set("userRole", meta?.role ?? null);
    }
  }

  await next();
};

/** Rechaza la request si no hay usuario autenticado. */
export const requireAuth: MiddlewareHandler<HonoCtx> = async (c, next) => {
  if (!c.get("userId")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

/** Rechaza si el usuario no es admin. Siempre usar después de requireAuth. */
export const requireAdmin: MiddlewareHandler<HonoCtx> = async (c, next) => {
  if (c.get("userRole") !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
};
