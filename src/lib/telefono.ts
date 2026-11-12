/**
 * Regla de teléfono compartida (web, WhatsApp, unión de contactos).
 * Hay una copia de este archivo, con sus tests, en front-crm.
 */

/** Últimos 10 dígitos; null si el teléfono tiene menos de 10 (no sirve para matchear). */
export function clave(tel: string | null | undefined): string | null {
  const digitos = (tel ?? "").replace(/\D/g, "");
  return digitos.length >= 10 ? digitos.slice(-10) : null;
}

export type MotivoTelefono = "con15" | "con0" | "corto" | "extranjero";

export type DiagnosticoTelefono =
  | { ok: true; whatsappId: string }
  | { ok: false; motivo: MotivoTelefono };

const ok = (diez: string): DiagnosticoTelefono => ({ ok: true, whatsappId: `549${diez}` });
const mal = (motivo: MotivoTelefono): DiagnosticoTelefono => ({ ok: false, motivo });

export function diagnosticoTelefono(tel: string): DiagnosticoTelefono {
  let d = tel.replace(/\D/g, "");
  const internacional = d.startsWith("00");
  if (internacional) d = d.slice(2);

  // Argentina con código de país: 549 + 10, o 54 + 10 (falta el 9).
  if (d.startsWith("54") && (internacional || d.length >= 11)) {
    const resto = d.slice(2);
    if (resto.length === 11 && resto.startsWith("9")) return ok(resto.slice(1));
    if (resto.length === 10) return ok(resto);
    return resto.length < 10 ? mal("corto") : mal("extranjero");
  }
  if (internacional) return mal("extranjero");

  if (d.startsWith("0")) return mal("con0");
  // Área + 15 + abonado: siempre 12 dígitos, con el 15 en la posición 2-4.
  if (d.length === 12 && [2, 3, 4].some((i) => d.slice(i, i + 2) === "15")) return mal("con15");
  if (d.length === 10 && d.startsWith("15")) return mal("con15");
  if (d.length === 10) return ok(d);
  if (d.length < 10) return mal("corto");
  return mal("extranjero");
}

export function aWhatsappId(tel: string): string | null {
  const r = diagnosticoTelefono(tel);
  return r.ok ? r.whatsappId : null;
}
