import type {
  ArcaClient,
  ArcaCreditNoteRequest,
  ArcaEmitRequest,
  ArcaEmitResult,
} from "./types";

const AFIP_SDK_BASE_URL = "https://app.afipsdk.com/api/v1";

// Códigos de comprobante WSFE
const INVOICE_TYPE_CODES: Record<string, number> = {
  A: 1,
  B: 6,
  C: 11,
};
const CREDIT_NOTE_CODES: Record<string, number> = {
  A: 3,
  B: 8,
  C: 13,
};

/** Error interno con metadata HTTP de Afip SDK. */
type AfipRequestError = Error & { httpStatus?: number; body?: unknown };

/**
 * Cliente real contra ARCA vía Afip SDK (https://docs.afipsdk.com) — API REST
 * compatible con Workers (fetch puro, sin SOAP ni openssl locales).
 *
 * PENDIENTE para activarlo (ARCA_MODE="afip"):
 *   1. Crear cuenta en afipsdk.com y obtener AFIP_SDK_TOKEN.
 *   2. Generar el certificado del CUIT emisor y asociarlo al wsfe
 *      (o usar modo homologación, `production=false`, default acá).
 *   3. `wrangler secret put AFIP_CUIT` y `wrangler secret put AFIP_SDK_TOKEN`.
 *   4. Probar contra homologación antes de producción.
 */
export class AfipArcaClient implements ArcaClient {
  constructor(
    private readonly cuit: string,
    private readonly sdkToken: string,
    private readonly production = false,
  ) {}

  async emitInvoice(req: ArcaEmitRequest): Promise<ArcaEmitResult> {
    const cbteTipo = INVOICE_TYPE_CODES[req.invoiceType];
    if (!cbteTipo) {
      return {
        ok: false,
        errorCode: "INVALID_TYPE",
        errorMessage: `Tipo de comprobante desconocido: ${req.invoiceType}`,
        rawResponse: null,
      };
    }

    let nextNro: number;
    try {
      // ARCA es la fuente de verdad de la numeración: pedimos el último
      // autorizado y emitimos el siguiente. No usamos el número propuesto
      // por la DB local (se desincroniza ante fallos parciales).
      const last = await this.getLastAuthorized(req.pointOfSale, cbteTipo);
      nextNro = last + 1;
    } catch (err) {
      return this.toErrorResult(err as AfipRequestError);
    }

    const serviceDate = formatDate(req.invoiceDate);
    return this.requestCae({
      CbteTipo: cbteTipo,
      PtoVta: req.pointOfSale,
      Concepto: 2, // servicios
      DocTipo: req.customer.docType === "CUIT" ? 80 : req.customer.docType === "DNI" ? 96 : 99,
      DocNro: req.customer.docNumber ? Number(req.customer.docNumber.replace(/\D/g, "")) : 0,
      CbteDesde: nextNro,
      CbteHasta: nextNro,
      CbteFch: serviceDate,
      ImpTotal: req.totalAmount,
      ImpTotConc: 0,
      ImpNeto: req.totalAmount, // Factura C: sin discriminar IVA
      ImpOpEx: 0,
      ImpIVA: 0,
      ImpTrib: 0,
      // Concepto=2 (servicios) exige las fechas de servicio y vto. de pago.
      FchServDesde: serviceDate,
      FchServHasta: serviceDate,
      FchVtoPago: serviceDate,
      MonId: "PES",
      MonCotiz: 1,
    });
  }

  async issueCreditNote(req: ArcaCreditNoteRequest): Promise<ArcaEmitResult> {
    const cbteTipo = CREDIT_NOTE_CODES[req.originalInvoiceType];
    const origTipo = INVOICE_TYPE_CODES[req.originalInvoiceType];
    if (!cbteTipo || !origTipo) {
      return {
        ok: false,
        errorCode: "INVALID_TYPE",
        errorMessage: `Tipo de comprobante desconocido: ${req.originalInvoiceType}`,
        rawResponse: null,
      };
    }

    let nextNro: number;
    try {
      const last = await this.getLastAuthorized(req.pointOfSale, cbteTipo);
      nextNro = last + 1;
    } catch (err) {
      return this.toErrorResult(err as AfipRequestError);
    }

    const today = formatDate(new Date());
    return this.requestCae({
      CbteTipo: cbteTipo,
      PtoVta: req.pointOfSale,
      Concepto: 2,
      DocTipo: 99,
      DocNro: 0,
      CbteDesde: nextNro,
      CbteHasta: nextNro,
      CbteFch: today,
      ImpTotal: req.totalAmount,
      ImpTotConc: 0,
      ImpNeto: req.totalAmount,
      ImpOpEx: 0,
      ImpIVA: 0,
      ImpTrib: 0,
      FchServDesde: today,
      FchServHasta: today,
      FchVtoPago: today,
      MonId: "PES",
      MonCotiz: 1,
      CbtesAsoc: [
        {
          Tipo: origTipo,
          PtoVta: req.pointOfSale,
          Nro: req.originalInvoiceNumber,
        },
      ],
    });
  }

  /** Consulta el último comprobante autorizado por ARCA para ese PV+tipo. */
  private async getLastAuthorized(ptoVta: number, cbteTipo: number): Promise<number> {
    const body = await this.afipRequest<{
      CbteNro?: number;
      FECompUltimoAutorizadoResult?: { CbteNro?: number };
    }>("FECompUltimoAutorizado", { PtoVta: ptoVta, CbteTipo: cbteTipo });

    const nro = body?.CbteNro ?? body?.FECompUltimoAutorizadoResult?.CbteNro;
    return Number(nro ?? 0);
  }

  private async requestCae(detail: Record<string, unknown>): Promise<ArcaEmitResult> {
    let body: any;
    try {
      body = await this.afipRequest("FECAESolicitar", {
        FeCAEReq: {
          FeCabReq: {
            CantReg: 1,
            PtoVta: detail.PtoVta,
            CbteTipo: detail.CbteTipo,
          },
          FeDetReq: {
            FECAEDetRequest: detail,
          },
        },
      });
    } catch (err) {
      return this.toErrorResult(err as AfipRequestError);
    }

    // Afip SDK puede devolver el resultado plano o envuelto en FeCAESolicitarResult.
    const root = body?.FeCAESolicitarResult ?? body;
    const det = root?.FeDetResp?.FECAEDetResponse?.[0];
    if (det?.Resultado === "A" && det?.CAE) {
      return {
        ok: true,
        cae: String(det.CAE),
        caeExpiry: parseAfipDate(String(det.CAEFchVto)),
        invoiceNumber: Number(det.CbteDesde),
        rawResponse: body,
      };
    }
    return {
      ok: false,
      errorCode: "REJECTED",
      errorMessage:
        det?.Observaciones?.Obs?.map((o: any) => o.Msg).join("; ") ??
        root?.Errors?.Err?.map((e: any) => e.Msg).join("; ") ??
        "Comprobante rechazado por ARCA",
      rawResponse: body,
    };
  }

  /** Request genérico a Afip SDK (wsfe). Lanza AfipRequestError si HTTP != 2xx. */
  private async afipRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${AFIP_SDK_BASE_URL}/afip/requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.sdkToken}`,
      },
      body: JSON.stringify({
        environment: this.production ? "prod" : "dev",
        tax_id: this.cuit,
        method,
        wsid: "wsfe",
        params,
      }),
    });

    const body: any = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(body?.message ?? "Error de Afip SDK") as AfipRequestError;
      err.httpStatus = res.status;
      err.body = body;
      throw err;
    }
    return body as T;
  }

  private toErrorResult(err: AfipRequestError): ArcaEmitResult {
    return {
      ok: false,
      errorCode: err.httpStatus ? `HTTP_${err.httpStatus}` : "REQUEST_ERROR",
      errorMessage: err.message,
      rawResponse: err.body ?? null,
    };
  }
}

/** Fecha local Argentina (UTC-3) en formato YYYYMMDD que exige WSFE. */
function formatDate(d: Date): string {
  const ar = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return ar.toISOString().slice(0, 10).replace(/-/g, "");
}

function parseAfipDate(yyyymmdd: string): Date {
  return new Date(
    `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00-03:00`,
  );
}
