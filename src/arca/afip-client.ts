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

/**
 * Cliente real contra ARCA vía Afip SDK (https://docs.afipsdk.com) — API REST
 * compatible con Workers (fetch puro, sin SOAP ni openssl locales).
 *
 * PENDIENTE para activarlo (ARCA_MODE="afip"):
 *   1. Crear cuenta en afipsdk.com y obtener AFIP_SDK_TOKEN.
 *   2. Asociar el certificado del CUIT emisor (o usar modo homologación).
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
    return this.requestCae({
      CbteTipo: cbteTipo,
      PtoVta: req.pointOfSale,
      Concepto: 2, // servicios
      DocTipo: req.customer.docType === "CUIT" ? 80 : req.customer.docType === "DNI" ? 96 : 99,
      DocNro: req.customer.docNumber ? Number(req.customer.docNumber.replace(/\D/g, "")) : 0,
      CbteFch: formatDate(req.invoiceDate),
      ImpTotal: req.totalAmount,
      ImpNeto: req.totalAmount, // Factura C: sin discriminar IVA
      MonId: "PES",
      MonCotiz: 1,
    });
  }

  async issueCreditNote(req: ArcaCreditNoteRequest): Promise<ArcaEmitResult> {
    const cbteTipo = CREDIT_NOTE_CODES[req.originalInvoiceType];
    if (!cbteTipo) {
      return {
        ok: false,
        errorCode: "INVALID_TYPE",
        errorMessage: `Tipo de comprobante desconocido: ${req.originalInvoiceType}`,
        rawResponse: null,
      };
    }
    return this.requestCae({
      CbteTipo: cbteTipo,
      PtoVta: req.pointOfSale,
      Concepto: 2,
      DocTipo: 99,
      DocNro: 0,
      CbteFch: formatDate(new Date()),
      ImpTotal: req.totalAmount,
      ImpNeto: req.totalAmount,
      MonId: "PES",
      MonCotiz: 1,
      CbtesAsoc: [
        {
          Tipo: INVOICE_TYPE_CODES[req.originalInvoiceType],
          PtoVta: req.pointOfSale,
          Nro: req.originalInvoiceNumber,
        },
      ],
    });
  }

  private async requestCae(detail: Record<string, unknown>): Promise<ArcaEmitResult> {
    // TODO(afip): validar contra homologación cuando estén las credenciales.
    const res = await fetch(`${AFIP_SDK_BASE_URL}/afip/requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.sdkToken}`,
      },
      body: JSON.stringify({
        environment: this.production ? "prod" : "dev",
        tax_id: this.cuit,
        method: "FECAESolicitar",
        wsid: "wsfe",
        params: {
          FeCAEReq: {
            FeCabReq: {
              CantReg: 1,
              PtoVta: detail.PtoVta,
              CbteTipo: detail.CbteTipo,
            },
            FeDetReq: {
              FECAEDetRequest: { ...detail, CbteDesde: undefined, CbteHasta: undefined },
            },
          },
        },
      }),
    });

    const body: any = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        errorCode: `HTTP_${res.status}`,
        errorMessage: body?.message ?? "Error de Afip SDK",
        rawResponse: body,
      };
    }

    const det = body?.FeDetResp?.FECAEDetResponse?.[0];
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
        body?.Errors?.Err?.map((e: any) => e.Msg).join("; ") ??
        "Comprobante rechazado por ARCA",
      rawResponse: body,
    };
  }
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function parseAfipDate(yyyymmdd: string): Date {
  return new Date(
    `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00-03:00`,
  );
}
