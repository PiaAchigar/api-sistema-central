import type {
  ArcaClient,
  ArcaCreditNoteRequest,
  ArcaEmitRequest,
  ArcaEmitResult,
} from "./types";

const CAE_VALIDITY_DAYS = 10;

/**
 * Cliente mock para desarrollo: genera CAE falsos de 14 dígitos con
 * vencimiento a 10 días, sin tocar ningún servicio externo.
 */
export class MockArcaClient implements ArcaClient {
  constructor(private readonly forceFail = false) {}

  async emitInvoice(req: ArcaEmitRequest): Promise<ArcaEmitResult> {
    if (this.forceFail) {
      return {
        ok: false,
        errorCode: "MOCK_FORCED_FAILURE",
        errorMessage: "Fallo simulado del mock ARCA (ARCA_MOCK_FAIL=true)",
        rawResponse: { mock: true, forced: true },
      };
    }
    const cae = generateFakeCae();
    return {
      ok: true,
      cae,
      caeExpiry: new Date(Date.now() + CAE_VALIDITY_DAYS * 24 * 60 * 60 * 1000),
      invoiceNumber: req.invoiceNumber,
      rawResponse: {
        mock: true,
        operation: "FECAESolicitar",
        pointOfSale: req.pointOfSale,
        invoiceType: req.invoiceType,
        invoiceNumber: req.invoiceNumber,
        totalAmount: req.totalAmount,
        result: "A",
        cae,
      },
    };
  }

  async issueCreditNote(req: ArcaCreditNoteRequest): Promise<ArcaEmitResult> {
    if (this.forceFail) {
      return {
        ok: false,
        errorCode: "MOCK_FORCED_FAILURE",
        errorMessage: "Fallo simulado del mock ARCA (ARCA_MOCK_FAIL=true)",
        rawResponse: { mock: true, forced: true },
      };
    }
    const cae = generateFakeCae();
    return {
      ok: true,
      cae,
      caeExpiry: new Date(Date.now() + CAE_VALIDITY_DAYS * 24 * 60 * 60 * 1000),
      invoiceNumber: req.originalInvoiceNumber,
      rawResponse: {
        mock: true,
        operation: "NotaCredito",
        cancels: `${req.originalInvoiceType}-${req.originalInvoiceNumber}`,
        totalAmount: req.totalAmount,
        reason: req.reason ?? null,
        result: "A",
        cae,
      },
    };
  }
}

function generateFakeCae(): string {
  let cae = "7"; // los CAE reales suelen empezar con 7
  for (let i = 0; i < 13; i++) cae += Math.floor(Math.random() * 10);
  return cae;
}
