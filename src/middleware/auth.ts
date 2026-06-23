import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AppBindings, Variables } from "../env";

type HonoCtx = { Bindings: AppBindings; Variables: Variables };

/**
 * Cache del JWKSet a nivel módulo, keyed por issuer.
 * Supabase firma los access tokens con ES256 (claves asimétricas), por eso se
 * valida contra el JWKS público del proyecto y NO con un secreto HMAC.
 * `createRemoteJWKSet` cachea las claves internamente (con cooldown ante rotación).
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(supabaseUrl: string) {
  let jwks = jwksCache.get(supabaseUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
    );
    jwksCache.set(supabaseUrl, jwks);
  }
  return jwks;
}

async function verifySupabaseJWT(
  token: string,
  supabaseUrl: string,
): Promise<JWTPayload | null> {
  try {
    const issuer = `${supabaseUrl}/auth/v1`;
    const { payload } = await jwtVerify(token, getJwks(supabaseUrl), {
      issuer,
      audience: "authenticated",
    });
    return payload;
  } catch {
    return null;
  }
}

/** Extrae userId y userRole del token si es válido. No bloquea si falta. */
export const auth: MiddlewareHandler<HonoCtx> = async (c, next) => {
  c.set("userId", null);
  c.set("userRole", null);

  // API key estática (x-api-key o Bearer con la key)
  if (c.env.API_KEY) {
    const apiKey =
      c.req.header("x-api-key") ??
      (c.req.header("Authorization")?.startsWith("Bearer ")
        ? c.req.header("Authorization")!.slice(7)
        : undefined);
    if (apiKey === c.env.API_KEY) {
      c.set("userId", "api-key");
      c.set("userRole", "admin");
      return next();
    }
  }

  // JWT de Supabase (ES256, verificado contra el JWKS del proyecto)
  const authHeader = c.req.header("Authorization");
  if (c.env.SUPABASE_URL && authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = await verifySupabaseJWT(token, c.env.SUPABASE_URL);
    if (payload) {
      c.set("userId", payload.sub ?? null);
      const meta = payload.app_metadata as { role?: string } | undefined;
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
