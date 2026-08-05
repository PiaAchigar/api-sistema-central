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
  /** Ambiente del cliente real: "prod" → producción, cualquier otro → homologación. */
  ARCA_ENV?: "homo" | "prod";
  /** Punto de venta ARCA (ej: 2 → "0002"). */
  ARCA_POS?: string;
  /** Tipo de comprobante por default (monotributo → "C"). */
  ARCA_INVOICE_TYPE?: string;
  /**
   * Master key (32 bytes en base64) para cifrar/descifrar las credenciales ARCA
   * de cada facturador guardadas en `arca_issuers` (AES-GCM, ver lib/secret-box.ts).
   * Configurar con `wrangler secret put ARCA_SECRETS_KEY`. Sin esto no se pueden
   * dar de alta ni usar facturadores (los endpoints responden 503).
   * Rotarla invalida los secretos ya guardados: hay que recargar los certificados.
   */
  ARCA_SECRETS_KEY?: string;
  /**
   * Master key (32 bytes en base64) para cifrar/descifrar las credenciales de
   * canal (WhatsApp, etc.) guardadas en `channel_credentials`, y también las
   * api_key de proveedores de IA guardadas en `ai_provider_credentials`
   * (mismo secreto, dos tablas — ver services/crypto.service.ts). Configurar
   * con `wrangler secret put CREDENTIALS_ENCRYPTION_KEY`. Rotarla invalida
   * las credenciales ya guardadas: hay que recargarlas desde Canales /
   * Automatización → Proveedores IA.
   */
  CREDENTIALS_ENCRYPTION_KEY?: string;
  /** Credenciales Afip SDK (solo para ARCA_MODE="afip"). */
  AFIP_CUIT?: string;
  AFIP_SDK_TOKEN?: string;
  /** Certificado X.509 y clave privada (PEM crudo o base64). Solo ARCA_MODE="afip". */
  AFIP_CERT?: string;
  AFIP_KEY?: string;
  /** Solo para tests: fuerza fallo del mock ARCA. */
  ARCA_MOCK_FAIL?: string;
  /**
   * API key de Resend (https://resend.com) para mandar alertas por email
   * (ver services/email-alert.service.ts — Task 3, confiabilidad WhatsApp).
   * Se usa la API HTTP de Resend, no SMTP: este Worker no tiene sockets TCP
   * crudos disponibles. Configurar con `wrangler secret put RESEND_API_KEY`.
   * Sin esto, las alertas quedan como log de servidor tag `[ALERT]`.
   */
  RESEND_API_KEY?: string;
  /** Remitente de las alertas por email. Default: "Piubella CRM <onboarding@resend.dev>". */
  ALERT_EMAIL_FROM?: string;
};
