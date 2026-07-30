import type { Db } from "../db/client";
import type { AppBindings } from "../env";
import { conflict, notFound } from "../lib/errors";
import { companyConfig } from "../db/schema";
import {
  getArcaLogsForInvoice,
  getInvoiceById,
  getInvoiceLineItems,
} from "../repositories/invoices.repo";
import { buildAfipQrUrl, createPdfViaAfipSdk, qrDataUrl } from "../arca/pdf";
import { resolveArcaPdfCredentials } from "../arca/factory";

const INVOICE_TYPE_CODES: Record<string, number> = { A: 1, B: 6, C: 11 };

const money = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 2,
});

/**
 * Genera el PDF de una factura emitida vía el servicio de PDF de Afip SDK.
 * Incluye el QR obligatorio de AFIP. Devuelve la URL del PDF (válida 24h).
 */
export async function generateInvoicePdf(db: Db, env: AppBindings, invoiceId: string) {
  const invoice = await getInvoiceById(db, invoiceId);
  if (!invoice) throw notFound("Invoice");
  if (invoice.status === "draft") {
    throw conflict("La factura debe emitirse (obtener CAE) antes de generar el PDF");
  }

  const logs = await getArcaLogsForInvoice(db, invoiceId);
  const success = logs.filter((l) => l.status === "success" && l.cae).pop();
  if (!success?.cae || invoice.invoiceNumber == null) {
    throw conflict("La factura no tiene CAE asociado");
  }

  const items = await getInvoiceLineItems(db, invoiceId);
  const [config] = await db.select().from(companyConfig).limit(1);

  // El QR y el encabezado llevan los datos del facturador que pidió el CAE.
  const creds = await resolveArcaPdfCredentials(db, env, invoice.issuerId);

  const invoiceType = invoice.invoiceType ?? creds.invoiceType;
  const tipoCmp = INVOICE_TYPE_CODES[invoiceType] ?? 11;
  const ptoVta = creds.pointOfSale;
  const cuit = Number(creds.cuit.replace(/\D/g, ""));
  const total = Number(invoice.totalAmount ?? 0);
  const emitDate = invoice.emittedAt ?? invoice.invoiceDate ?? new Date();
  const fecha = formatDateIso(emitDate);
  const dni = invoice.customerDni ? Number(invoice.customerDni.replace(/\D/g, "")) : null;

  const qrUrl = buildAfipQrUrl({
    fecha,
    cuit,
    ptoVta,
    tipoCmp,
    nroCmp: invoice.invoiceNumber,
    importe: total,
    tipoDocRec: dni ? 96 : undefined,
    nroDocRec: dni ?? undefined,
    codAut: Number(success.cae),
  });

  const html = renderInvoiceHtml({
    companyName: config?.companyName ?? "PiuBella",
    address: config?.address ?? null,
    cuit: creds.cuit,
    invoiceType,
    ptoVta,
    number: invoice.invoiceNumber,
    fecha,
    customerName: invoice.customerName ?? "Consumidor Final",
    customerDni: invoice.customerDni ?? null,
    items: items.map((i) => ({
      description: i.serviceName ?? i.productName ?? "Ítem",
      quantity: Number(i.quantity ?? 1),
      unitPrice: Number(i.unitPrice ?? 0),
      total: Number(i.totalAmount ?? 0),
    })),
    total,
    cae: success.cae,
    caeExpiry: success.caeExpiry ? formatDateIso(success.caeExpiry) : "—",
    qrDataUrl: qrDataUrl(qrUrl),
  });

  const fileName = `factura-${invoiceType}-${String(ptoVta).padStart(4, "0")}-${String(
    invoice.invoiceNumber,
  ).padStart(8, "0")}`;

  return createPdfViaAfipSdk(creds.sdkToken, creds.production, html, fileName);
}

function formatDateIso(d: Date): string {
  const ar = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return ar.toISOString().slice(0, 10);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type InvoiceHtmlData = {
  companyName: string;
  address: string | null;
  cuit: string;
  invoiceType: string;
  ptoVta: number;
  number: number;
  fecha: string;
  customerName: string;
  customerDni: string | null;
  items: { description: string; quantity: number; unitPrice: number; total: number }[];
  total: number;
  cae: string;
  caeExpiry: string;
  qrDataUrl: string;
};

function renderInvoiceHtml(d: InvoiceHtmlData): string {
  const comprobante = `${String(d.ptoVta).padStart(4, "0")}-${String(d.number).padStart(8, "0")}`;
  const rows = d.items
    .map(
      (i) => `
      <tr>
        <td>${escapeHtml(i.description)}</td>
        <td class="num">${i.quantity}</td>
        <td class="num">${money.format(i.unitPrice)}</td>
        <td class="num">${money.format(i.total)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 12px; margin: 0; padding: 24px; }
  .header { display: flex; border: 2px solid #1a1a1a; }
  .header > div { padding: 12px 16px; }
  .emisor { flex: 1; border-right: 2px solid #1a1a1a; }
  .tipo { width: 70px; text-align: center; border-right: 2px solid #1a1a1a; }
  .tipo .letra { font-size: 40px; font-weight: bold; line-height: 1; }
  .tipo .cod { font-size: 9px; }
  .comprobante { flex: 1; }
  .company { font-size: 20px; font-weight: bold; }
  h1 { font-size: 16px; margin: 0 0 6px; }
  .muted { color: #555; }
  .box { border: 1px solid #999; padding: 10px 12px; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
  th { background: #f0f0f0; }
  td.num, th.num { text-align: right; }
  .total { text-align: right; font-size: 16px; font-weight: bold; margin-top: 12px; }
  .footer { display: flex; align-items: center; gap: 16px; margin-top: 20px; border-top: 1px solid #999; padding-top: 12px; }
  .footer img { width: 110px; height: 110px; }
  .cae { font-size: 13px; }
</style>
</head>
<body>
  <div class="header">
    <div class="emisor">
      <div class="company">${escapeHtml(d.companyName)}</div>
      ${d.address ? `<div class="muted">${escapeHtml(d.address)}</div>` : ""}
      <div class="muted">CUIT: ${escapeHtml(d.cuit)}</div>
      <div class="muted">Responsable Monotributo</div>
    </div>
    <div class="tipo">
      <div class="letra">${escapeHtml(d.invoiceType)}</div>
      <div class="cod">COD. ${INVOICE_TYPE_CODES[d.invoiceType] ?? 11}</div>
    </div>
    <div class="comprobante">
      <h1>FACTURA</h1>
      <div><strong>N°:</strong> ${comprobante}</div>
      <div><strong>Fecha:</strong> ${d.fecha}</div>
    </div>
  </div>

  <div class="box">
    <div><strong>Cliente:</strong> ${escapeHtml(d.customerName)}</div>
    ${d.customerDni ? `<div><strong>DNI:</strong> ${escapeHtml(d.customerDni)}</div>` : ""}
    <div><strong>Condición frente al IVA:</strong> Consumidor Final</div>
  </div>

  <table>
    <thead>
      <tr><th>Descripción</th><th class="num">Cant.</th><th class="num">P. Unit.</th><th class="num">Importe</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="total">TOTAL: ${money.format(d.total)}</div>

  <div class="footer">
    <img src="${d.qrDataUrl}" alt="QR AFIP" />
    <div class="cae">
      <div><strong>CAE N°:</strong> ${escapeHtml(d.cae)}</div>
      <div><strong>Vto. CAE:</strong> ${d.caeExpiry}</div>
      <div class="muted">Comprobante Autorizado</div>
    </div>
  </div>
</body>
</html>`;
}
