export type Variables = {
  requestId: string;
  userId: string | null;
  userRole: string | null;
};

export type AppBindings = Omit<Env, "ARCA_MODE"> & {
  /** JWT secret de Supabase — obligatorio en prod, opcional en dev local (ver .dev.vars). */
  SUPABASE_JWT_SECRET?: string;
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
