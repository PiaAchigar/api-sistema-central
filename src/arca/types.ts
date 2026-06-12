export type ArcaEmitRequest = {
  pointOfSale: number;
  invoiceType: string; // "C" para monotributo
  /** Número correlativo propuesto (el cliente real puede reasignar). */
  invoiceNumber: number;
  totalAmount: number;
  invoiceDate: Date;
  customer: {
    docType: "DNI" | "CUIT" | "CONSUMIDOR_FINAL";
    docNumber: string | null;
    name: string | null;
  };
};

export type ArcaEmitResult =
  | {
      ok: true;
      cae: string;
      caeExpiry: Date;
      invoiceNumber: number;
      rawResponse: unknown;
    }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
      rawResponse: unknown;
    };

export type ArcaCreditNoteRequest = {
  pointOfSale: number;
  /** Comprobante original que se anula. */
  originalInvoiceType: string;
  originalInvoiceNumber: number;
  totalAmount: number;
  reason?: string;
};

/**
 * Adapter de facturación electrónica ARCA (ex AFIP).
 * Implementaciones: MockArcaClient (dev) y AfipArcaClient (real vía Afip SDK).
 */
export interface ArcaClient {
  emitInvoice(req: ArcaEmitRequest): Promise<ArcaEmitResult>;
  issueCreditNote(req: ArcaCreditNoteRequest): Promise<ArcaEmitResult>;
}
