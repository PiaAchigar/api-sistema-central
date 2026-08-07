import type {
  ArcaClient,
  ArcaCreditNoteRequest,
  ArcaEmitRequest,
  ArcaEmitResult,
} from "./types";
import { utcToLocalDateString } from "../lib/time";

const AFIP_SDK_BASE_URL = "https://app.afipsdk.com/api/v1";

// Endpoints SOAP de ARCA (wsfe) según ambiente — los reenvía Afip SDK.
const WSFE_URL_PROD = "https://servicios1.afip.gov.ar/wsfev1/service.asmx";
const WSFE_URL_TEST = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";
const WSFE_WSDL_PROD = "wsfe-production.wsdl";
const WSFE_WSDL_TEST = "wsfe.wsdl";

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

/** Ticket de Acceso de ARCA (lo cachea Afip SDK del lado servidor). */
type TokenAuth = { token: string; sign: string };

/** Error interno con metadata HTTP de Afip SDK. */
type AfipRequestError = Error & { httpStatus?: number; body?: unknown };

/**
 * Cliente real contra ARCA vía Afip SDK (https://docs.afipsdk.com) — API REST
 * compatible con Workers (fetch puro, sin SOAP ni openssl locales).
 *
 * Flujo en 2 pasos que replica @afipsdk/afip.js:
 *   1. POST /afip/auth con cert+key → devuelve el TA { token, sign }.
 *   2. POST /afip/requests con method+params (incluyendo Auth) → ejecuta el WS.
 *
 * El certificado y la clave NO se suben a ningún dashboard: viajan en el body
 * del paso de auth. Se configuran como secretos del Worker (AFIP_CERT/AFIP_KEY).
 */
export class AfipArcaClient implements ArcaClient {
  /** Cache del TA para la vida del isolate (Afip SDK además cachea server-side). */
  private ta: TokenAuth | null = null;

  constructor(
    private readonly cuit: string,
    private readonly sdkToken: string,
    private readonly cert: string,
    private readonly key: string,
    private readonly production = false,
  ) {}

  async emitInvoice(req: ArcaEmitRequest): Promise<ArcaEmitResult> {
    const cbteTipo = INVOICE_TYPE_CODES[req.invoiceType];
    if (!cbteTipo) {
      return invalidType(req.invoiceType);
    }

    try {
      const ta = await this.getTokenAuth();
      // ARCA es la fuente de verdad de la numeración: pedimos el último
      // autorizado y emitimos el siguiente. No usamos el número propuesto por
      // la DB local (se desincroniza ante fallos parciales).
      const last = await this.getLastAuthorized(ta, req.pointOfSale, cbteTipo);
      const nextNro = last + 1;
      const serviceDate = formatDate(req.invoiceDate);

      return await this.requestCae(ta, {
        CbteTipo: cbteTipo,
        PtoVta: req.pointOfSale,
        Concepto: 2, // servicios
        DocTipo: req.customer.docType === "CUIT" ? 80 : req.customer.docType === "DNI" ? 96 : 99,
        DocNro: req.customer.docNumber ? Number(req.customer.docNumber.replace(/\D/g, "")) : 0,
        // Obligatorio desde RG 5616. Para DNI/consumidor final → 5 (Consumidor Final).
        CondicionIVAReceptorId: ivaReceptorId(req.customer.docType),
        CbteDesde: nextNro,
        CbteHasta: nextNro,
        CbteFch: serviceDate,
        ImpTotal: req.totalAmount,
        ImpTotConc: 0,
        ImpNeto: req.totalAmount, // Factura C: sin discriminar IVA
        ImpOpEx: 0,
        ImpIVA: 0,
        ImpTrib: 0,
        // Concepto=2 (servicios) exige fechas de servicio y vto. de pago.
        FchServDesde: serviceDate,
        FchServHasta: serviceDate,
        FchVtoPago: serviceDate,
        MonId: "PES",
        MonCotiz: 1,
      });
    } catch (err) {
      return toErrorResult(err as AfipRequestError);
    }
  }

  async issueCreditNote(req: ArcaCreditNoteRequest): Promise<ArcaEmitResult> {
    const cbteTipo = CREDIT_NOTE_CODES[req.originalInvoiceType];
    const origTipo = INVOICE_TYPE_CODES[req.originalInvoiceType];
    if (!cbteTipo || !origTipo) {
      return invalidType(req.originalInvoiceType);
    }

    try {
      const ta = await this.getTokenAuth();
      const last = await this.getLastAuthorized(ta, req.pointOfSale, cbteTipo);
      const nextNro = last + 1;
      const today = formatDate(new Date());

      return await this.requestCae(ta, {
        CbteTipo: cbteTipo,
        PtoVta: req.pointOfSale,
        Concepto: 2,
        DocTipo: 99,
        DocNro: 0,
        CondicionIVAReceptorId: 5, // Consumidor Final (RG 5616)
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
        CbtesAsoc: {
          CbteAsoc: [
            { Tipo: origTipo, PtoVta: req.pointOfSale, Nro: req.originalInvoiceNumber },
          ],
        },
      });
    } catch (err) {
      return toErrorResult(err as AfipRequestError);
    }
  }

  /** Paso 1: obtiene el TA (token/sign) usando cert+key. Cachea en el isolate. */
  private async getTokenAuth(): Promise<TokenAuth> {
    if (this.ta) return this.ta;

    const body = await this.adminRequest<{ token?: string; sign?: string }>("afip/auth", {
      environment: this.production ? "prod" : "dev",
      wsid: "wsfe",
      tax_id: this.cuit,
      force_create: false,
      cert: this.cert,
      key: this.key,
    });

    if (!body?.token || !body?.sign) {
      const err = new Error("Afip SDK no devolvió el TA (token/sign)") as AfipRequestError;
      err.body = body;
      throw err;
    }
    this.ta = { token: body.token, sign: body.sign };
    return this.ta;
  }

  /** Consulta el último comprobante autorizado por ARCA para ese PV+tipo. */
  private async getLastAuthorized(
    ta: TokenAuth,
    ptoVta: number,
    cbteTipo: number,
  ): Promise<number> {
    const result = await this.executeWs(ta, "FECompUltimoAutorizado", {
      PtoVta: ptoVta,
      CbteTipo: cbteTipo,
    });
    return Number(result?.CbteNro ?? 0);
  }

  /** Paso 2 para FECAESolicitar: arma el sobre FeCAEReq y parsea el CAE. */
  private async requestCae(
    ta: TokenAuth,
    detail: Record<string, unknown>,
  ): Promise<ArcaEmitResult> {
    let result: any;
    try {
      result = await this.executeWs(ta, "FECAESolicitar", {
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
      return toErrorResult(err as AfipRequestError);
    }

    const detResp = result?.FeDetResp?.FECAEDetResponse;
    const det = Array.isArray(detResp) ? detResp[0] : detResp;

    if (det?.Resultado === "A" && det?.CAE) {
      return {
        ok: true,
        cae: String(det.CAE),
        caeExpiry: parseAfipDate(String(det.CAEFchVto)),
        invoiceNumber: Number(det.CbteDesde),
        rawResponse: result,
      };
    }
    return {
      ok: false,
      errorCode: "REJECTED",
      errorMessage:
        toMsgList(det?.Observaciones?.Obs) ??
        toMsgList(result?.Errors?.Err) ??
        "Comprobante rechazado por ARCA",
      rawResponse: result,
    };
  }

  /**
   * Ejecuta un método de wsfe vía Afip SDK (paso 2). Inyecta el Auth con el TA
   * y devuelve el contenido de `<Method>Result`.
   */
  private async executeWs(
    ta: TokenAuth,
    method: string,
    operationParams: Record<string, unknown>,
  ): Promise<any> {
    const body = await this.adminRequest<Record<string, unknown>>("afip/requests", {
      method,
      params: {
        ...operationParams,
        Auth: { Token: ta.token, Sign: ta.sign, Cuit: this.cuit },
      },
      environment: this.production ? "prod" : "dev",
      wsid: "wsfe",
      url: this.production ? WSFE_URL_PROD : WSFE_URL_TEST,
      wsdl: this.production ? WSFE_WSDL_PROD : WSFE_WSDL_TEST,
      soap_v_1_2: true,
    });
    return body?.[`${method}Result`] ?? body;
  }

  /** POST genérico a la API de Afip SDK. Lanza AfipRequestError si HTTP != 2xx. */
  private async adminRequest<T = unknown>(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${AFIP_SDK_BASE_URL}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.sdkToken}`,
        "sdk-version-number": "1.2.2",
        "sdk-library": "javascript",
        "sdk-environment": this.production ? "prod" : "dev",
      },
      body: JSON.stringify(payload),
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
}

/**
 * Condición frente al IVA del receptor (RG 5616, método FEParamGetCondicionIvaReceptor).
 *   5 = Consumidor Final · 1 = Responsable Inscripto · 6 = Responsable Monotributo
 * Para esta estética los clientes son consumidores finales (DNI). Un CUIT se
 * asume Responsable Inscripto; ajustar si se factura a monotributistas/exentos.
 */
function ivaReceptorId(docType: ArcaEmitRequest["customer"]["docType"]): number {
  return docType === "CUIT" ? 1 : 5;
}

function invalidType(type: string): ArcaEmitResult {
  return {
    ok: false,
    errorCode: "INVALID_TYPE",
    errorMessage: `Tipo de comprobante desconocido: ${type}`,
    rawResponse: null,
  };
}

function toErrorResult(err: AfipRequestError): ArcaEmitResult {
  return {
    ok: false,
    errorCode: err.httpStatus ? `HTTP_${err.httpStatus}` : "REQUEST_ERROR",
    errorMessage: err.message,
    rawResponse: err.body ?? null,
  };
}

/** Aplana Observaciones/Errores de ARCA (objeto o array) a un string. */
function toMsgList(node: unknown): string | undefined {
  if (!node) return undefined;
  const arr = Array.isArray(node) ? node : [node];
  const msgs = arr.map((o: any) => o?.Msg).filter(Boolean);
  return msgs.length ? msgs.join("; ") : undefined;
}

/** Fecha local Argentina en formato YYYYMMDD que exige WSFE. */
function formatDate(d: Date): string {
  return utcToLocalDateString(d).replace(/-/g, "");
}

function parseAfipDate(yyyymmdd: string): Date {
  return new Date(
    `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00-03:00`,
  );
}
