import { AppError } from "./errors";

/**
 * Cliente mínimo de la Auth Admin API de Supabase (GoTrue), usado server-side
 * con el `service_role` para gestionar usuarios. NUNCA exponer la key al cliente.
 */
export type AdminUser = {
  id: string;
  email: string | null;
  role: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
};

type GoTrueUser = {
  id: string;
  email?: string | null;
  app_metadata?: { role?: string | null } | null;
  created_at?: string | null;
  last_sign_in_at?: string | null;
};

export type SupabaseAdminConfig = { url: string; serviceRoleKey: string };

/** Devuelve la config si está disponible; si no, lanza 503. */
export function requireSupabaseAdmin(env: {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}): SupabaseAdminConfig {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new AppError(
      503,
      "Gestión de usuarios no disponible: falta SUPABASE_SERVICE_ROLE_KEY en el Worker.",
    );
  }
  return { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY };
}

function mapUser(u: GoTrueUser): AdminUser {
  return {
    id: u.id,
    email: u.email ?? null,
    role: u.app_metadata?.role ?? null,
    createdAt: u.created_at ?? null,
    lastSignInAt: u.last_sign_in_at ?? null,
  };
}

async function gotrue(
  cfg: SupabaseAdminConfig,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${cfg.url}/auth/v1/admin${path}`, {
    ...init,
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const msg =
      (body as { msg?: string; error_description?: string; error?: string } | null)?.msg ??
      (body as { error_description?: string } | null)?.error_description ??
      (body as { error?: string } | null)?.error ??
      `Supabase Auth devolvió ${res.status}`;
    throw new AppError(res.status === 404 ? 404 : 502, msg);
  }
  return body;
}

export async function listUsers(cfg: SupabaseAdminConfig): Promise<AdminUser[]> {
  const body = (await gotrue(cfg, "/users?per_page=200")) as { users?: GoTrueUser[] };
  return (body.users ?? []).map(mapUser);
}

export async function createUser(
  cfg: SupabaseAdminConfig,
  data: { email: string; password: string; role: string },
): Promise<AdminUser> {
  const body = (await gotrue(cfg, "/users", {
    method: "POST",
    body: JSON.stringify({
      email: data.email,
      password: data.password,
      email_confirm: true,
      app_metadata: { role: data.role },
    }),
  })) as GoTrueUser;
  return mapUser(body);
}

export async function updateUserRole(
  cfg: SupabaseAdminConfig,
  id: string,
  role: string,
): Promise<AdminUser> {
  const body = (await gotrue(cfg, `/users/${id}`, {
    method: "PUT",
    body: JSON.stringify({ app_metadata: { role } }),
  })) as GoTrueUser;
  return mapUser(body);
}

export async function deleteUser(cfg: SupabaseAdminConfig, id: string): Promise<void> {
  await gotrue(cfg, `/users/${id}`, { method: "DELETE" });
}
