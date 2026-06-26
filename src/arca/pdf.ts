import qrcode from "qrcode-generator";

const AFIP_SDK_BASE_URL = "https://app.afipsdk.com/api/v1";
const AFIP_QR_BASE = "https://www.afip.gob.ar/fe/qr/?p=";

export type AfipQrData = {
  /** Fecha de emisión en formato YYYY-MM-DD. */
  fecha: string;
  cuit: number; // CUIT del emisor
  ptoVta: number;
  tipoCmp: number; // 11 = Factura C
  nroCmp: number;
  importe: number; // total
  /** Tipo de doc del receptor (96 DNI, 80 CUIT, 99 CF) — opcional. */
  tipoDocRec?: number;
  nroDocRec?: number;
  /** Código de autorización (CAE) como número. */
  codAut: number;
};

/**
 * Arma la URL del QR obligatorio de AFIP (RG 4892). Encodea un JSON con los
 * datos del comprobante en base64 dentro de https://afip.gob.ar/fe/qr/?p=...
 * Spec: https://www.afip.gob.ar/fe/qr/documentos/QRespecificaciones.pdf
 */
export function buildAfipQrUrl(d: AfipQrData): string {
  const payload: Record<string, unknown> = {
    ver: 1,
    fecha: d.fecha,
    cuit: d.cuit,
    ptoVta: d.ptoVta,
    tipoCmp: d.tipoCmp,
    nroCmp: d.nroCmp,
    importe: d.importe,
    moneda: "PES",
    ctz: 1,
    tipoCodAut: "E", // E = CAE
    codAut: d.codAut,
  };
  if (d.tipoDocRec != null && d.nroDocRec != null) {
    payload.tipoDocRec = d.tipoDocRec;
    payload.nroDocRec = d.nroDocRec;
  }
  const json = JSON.stringify(payload);
  // btoa solo maneja Latin-1; el JSON acá es ASCII puro, así que es seguro.
  return AFIP_QR_BASE + btoa(json);
}

/** Genera el QR como data URL (GIF base64) listo para un <img>. Puro JS. */
export function qrDataUrl(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(4, 8);
}

/**
 * Llama al servicio de PDF de Afip SDK. Devuelve la URL del PDF (válida 24h).
 * Es independiente de los web services: solo renderiza HTML a PDF.
 */
export async function createPdfViaAfipSdk(
  sdkToken: string,
  production: boolean,
  html: string,
  fileName: string,
): Promise<{ url: string; fileName: string }> {
  const res = await fetch(`${AFIP_SDK_BASE_URL}/pdfs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sdkToken}`,
      "sdk-version-number": "1.2.2",
      "sdk-library": "javascript",
      "sdk-environment": production ? "prod" : "dev",
    },
    body: JSON.stringify({
      html,
      file_name: fileName,
      options: { format: "A4" },
    }),
  });

  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.file) {
    throw new Error(body?.message ?? "Afip SDK no pudo generar el PDF");
  }
  return { url: body.file, fileName: body.file_name ?? `${fileName}.pdf` };
}
