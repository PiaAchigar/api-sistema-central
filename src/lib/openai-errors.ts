// api-sistema-central/src/lib/openai-errors.ts
//
// Traduce los errores de la API de OpenAI a mensajes que Laura pueda accionar
// desde el dashboard. Función pura: no hace red ni toca la base, así que se
// testea sola.
//
// OJO: `insufficient_quota` y `rate_limit_exceeded` llegan los DOS con status
// 429. Discriminar por status daría "esperá un minuto" cuando en realidad se
// acabó el crédito, y nadie entendería por qué nunca se arregla. Por eso el
// código del cuerpo manda sobre el status.

export type ErrorOpenAI = {
  /** Código de OpenAI, o "desconocido" si no lo pudimos identificar. */
  codigo: string;
  /** Texto listo para mostrar en pantalla, en español. */
  mensaje: string;
  /** True solo cuando la cuenta se quedó sin saldo. Corta los reintentos. */
  esFaltaDeCredito: boolean;
  /** Texto original de OpenAI, para el detalle plegable. */
  detalle?: string;
};

const MENSAJES: Record<string, { mensaje: string; esFaltaDeCredito: boolean }> = {
  insufficient_quota: {
    mensaje:
      "La cuenta de OpenAI se quedó sin crédito. Hay que cargar saldo en platform.openai.com.",
    esFaltaDeCredito: true,
  },
  invalid_api_key: {
    mensaje: "La clave no es válida. Fijate que esté copiada completa, sin espacios.",
    esFaltaDeCredito: false,
  },
  rate_limit_exceeded: {
    mensaje: "Demasiadas solicitudes juntas. Esperá un minuto y probá de nuevo.",
    esFaltaDeCredito: false,
  },
  model_not_found: {
    mensaje: "El modelo configurado no existe o la cuenta no tiene acceso.",
    esFaltaDeCredito: false,
  },
};

/** Saca `{ code, type, message }` del cuerpo, venga como objeto o como string. */
function leerError(body: unknown): { code?: string; type?: string; message?: string; texto: string } {
  if (typeof body === "string") {
    const texto = body;
    try {
      return { ...leerError(JSON.parse(body)), texto };
    } catch {
      return { texto };
    }
  }
  if (body && typeof body === "object") {
    const err = (body as { error?: { code?: string; type?: string; message?: string } }).error;
    return {
      code: err?.code,
      type: err?.type,
      message: err?.message,
      texto: JSON.stringify(body),
    };
  }
  return { texto: String(body) };
}

export function mapearErrorOpenAI(status: number, body: unknown): ErrorOpenAI {
  const { code, type, message, texto } = leerError(body);

  // `code` primero, `type` de respaldo: algunos errores de cuota vienen solo
  // con `type`.
  const codigo = (code && MENSAJES[code] ? code : undefined) ?? (type && MENSAJES[type] ? type : undefined);

  if (codigo) {
    return {
      codigo,
      mensaje: MENSAJES[codigo]!.mensaje,
      esFaltaDeCredito: MENSAJES[codigo]!.esFaltaDeCredito,
      detalle: message ?? texto,
    };
  }

  return {
    codigo: "desconocido",
    mensaje: `OpenAI rechazó la solicitud (código ${status}).`,
    esFaltaDeCredito: false,
    detalle: message ?? texto,
  };
}
