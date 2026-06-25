export type Variables = {
  requestId: string;
  userId: string | null;
  userRole: string | null;
};

export type AppBindings = Omit<Env, "ARCA_MODE"> & {
  /**
   * URL base del proyecto Supabase (ej: https://xxxx.supabase.co).
   * Se usa para verificar los access tokens (ES256) contra el JWKS público
   * en `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. No es secreto.
   */
  SUPABASE_URL?: string;
  /** API key estática — acepta x-api-key header o Bearer token. Asigna role=admin. */
  API_KEY?: string;
  /**
   * Service role key de Supabase (secreto, server-side only). Habilita la gestión
   * de usuarios vía Auth Admin API. Configurar con `wrangler secret put
   * SUPABASE_SERVICE_ROLE_KEY`. Si falta, los endpoints de usuarios responden 503.
   */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** "mock" emite CAE falsos; "afip" usa el cliente real (requiere AFIP_*). */
  ARCA_MODE?: "mock" | "afip";
  /** Punto de venta ARCA (ej: 2 → "0002"). */
  ARCA_POS?: string;
  /** Tipo de comprobante por default (monotributo → "C"). */
  ARCA_INVOICE_TYPE?: string;
  /** Credenciales Afip SDK (solo para ARCA_MODE="afip"). */
  AFIP_CUIT?: string;
  AFIP_SDK_TOKEN?: string;
  /** Solo para tests: fuerza fallo del mock ARCA. */
  ARCA_MOCK_FAIL?: string;
};
