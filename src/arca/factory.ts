import type { Db } from "../db/client";
import type { AppBindings } from "../env";
import { AppError, badRequest, notFound } from "../lib/errors";
import { decryptSecret } from "../lib/secret-box";
import {
  getDefaultIssuerWithSecrets,
  getIssuerWithSecrets,
} from "../repositories/issuers.repo";
import { AfipArcaClient } from "./afip-client";
import { MockArcaClient } from "./mock-client";
import type { ArcaClient } from "./types";

export type ArcaConfig = {
  client: ArcaClient;
  pointOfSale: number;
  invoiceType: string;
  /** Facturador usado (null = credenciales del Worker, sin multi-facturador). */
  issuerId: string | null;
  issuerName: string | null;
};

/**
 * Config a partir de las variables del Worker (modo legacy / mock).
 * Se sigue usando cuando `ARCA_MODE` no es "afip" (dev) y como respaldo si
 * todavía no se cargó ningún facturador en la base.
 */
export function createArcaClient(env: AppBindings): ArcaConfig {
  const pointOfSale = Number(env.ARCA_POS ?? "2");
  const invoiceType = env.ARCA_INVOICE_TYPE ?? "C";

  if (env.ARCA_MODE === "afip") {
    if (!env.AFIP_CUIT || !env.AFIP_SDK_TOKEN || !env.AFIP_CERT || !env.AFIP_KEY) {
      throw new Error(
        "ARCA_MODE=afip requiere los secretos AFIP_CUIT, AFIP_SDK_TOKEN, AFIP_CERT y AFIP_KEY",
      );
    }
    return {
      client: new AfipArcaClient(
        env.AFIP_CUIT,
        env.AFIP_SDK_TOKEN,
        decodePem(env.AFIP_CERT),
        decodePem(env.AFIP_KEY),
        env.ARCA_ENV === "prod",
      ),
      pointOfSale,
      invoiceType,
      issuerId: null,
      issuerName: null,
    };
  }

  return {
    client: new MockArcaClient(env.ARCA_MOCK_FAIL === "true"),
    pointOfSale,
    invoiceType,
    issuerId: null,
    issuerName: null,
  };
}

/**
 * Config del facturador elegido (o del marcado por defecto).
 *
 * Reglas:
 *  - `ARCA_MODE` != "afip" (dev) → cliente MOCK siempre, pero respetando punto de
 *    venta / tipo de comprobante / id del facturador elegido. Así se puede probar
 *    todo el circuito multi-facturador sin certificados reales.
 *  - `issuerId` explícito que no existe o está inactivo → error (nunca se factura
 *    en silencio con otra identidad fiscal).
 *  - Sin facturadores cargados → cae a las credenciales del Worker (compatibilidad
 *    con la instalación previa al multi-facturador).
 */
export async function resolveArcaConfig(
  db: Db,
  env: AppBindings,
  issuerId?: string | null,
): Promise<ArcaConfig> {
  const issuer = issuerId
    ? await getIssuerWithSecrets(db, issuerId)
    : await getDefaultIssuerWithSecrets(db);

  if (issuerId && !issuer) throw notFound("Facturador");
  if (issuer && issuer.isActive === false) {
    throw badRequest(`El facturador "${issuer.name}" está desactivado.`);
  }

  // Sin facturadores en la base todavía: credenciales del Worker (legacy).
  if (!issuer) return createArcaClient(env);

  const pointOfSale = issuer.pointOfSale ?? 1;
  const invoiceType = issuer.invoiceType ?? "C";

  if (env.ARCA_MODE !== "afip") {
    return {
      client: new MockArcaClient(env.ARCA_MOCK_FAIL === "true"),
      pointOfSale,
      invoiceType,
      issuerId: issuer.id,
      issuerName: issuer.name,
    };
  }

  if (!issuer.cuit || !issuer.sdkTokenEnc || !issuer.certEnc || !issuer.keyEnc) {
    throw new AppError(
      500,
      `El facturador "${issuer.name}" no tiene credenciales completas cargadas.`,
    );
  }

  const [sdkToken, cert, key] = await Promise.all([
    decryptSecret(issuer.sdkTokenEnc, env.ARCA_SECRETS_KEY),
    decryptSecret(issuer.certEnc, env.ARCA_SECRETS_KEY),
    decryptSecret(issuer.keyEnc, env.ARCA_SECRETS_KEY),
  ]);

  return {
    client: new AfipArcaClient(
      issuer.cuit,
      sdkToken,
      decodePem(cert),
      decodePem(key),
      issuer.environment === "prod",
    ),
    pointOfSale,
    invoiceType,
    issuerId: issuer.id,
    issuerName: issuer.name,
  };
}

/** Datos del emisor que necesita el generador de PDF (CUIT/QR y token del SDK). */
export type ArcaPdfCredentials = {
  cuit: string;
  sdkToken: string;
  pointOfSale: number;
  invoiceType: string;
  production: boolean;
};

/**
 * Credenciales para armar el PDF y el QR de AFIP de una factura ya emitida.
 * Tiene que ser el MISMO emisor que pidió el CAE: el QR lleva su CUIT y punto
 * de venta, y si no coinciden con el comprobante el QR queda inválido.
 */
export async function resolveArcaPdfCredentials(
  db: Db,
  env: AppBindings,
  issuerId?: string | null,
): Promise<ArcaPdfCredentials> {
  const issuer = issuerId
    ? await getIssuerWithSecrets(db, issuerId)
    : await getDefaultIssuerWithSecrets(db);

  if (issuer?.cuit && issuer.sdkTokenEnc) {
    return {
      cuit: issuer.cuit,
      sdkToken: await decryptSecret(issuer.sdkTokenEnc, env.ARCA_SECRETS_KEY),
      pointOfSale: issuer.pointOfSale ?? 1,
      invoiceType: issuer.invoiceType ?? "C",
      production: issuer.environment === "prod",
    };
  }

  // Facturas previas al multi-facturador: credenciales del Worker.
  if (!env.AFIP_SDK_TOKEN || !env.AFIP_CUIT) {
    throw badRequest(
      "El PDF necesita un facturador con CUIT y token de Afip SDK (o las variables AFIP_* del Worker).",
    );
  }
  return {
    cuit: env.AFIP_CUIT,
    sdkToken: env.AFIP_SDK_TOKEN,
    pointOfSale: Number(env.ARCA_POS ?? "2"),
    invoiceType: env.ARCA_INVOICE_TYPE ?? "C",
    production: env.ARCA_ENV === "prod",
  };
}

/**
 * Acepta PEM crudo (multilínea, ideal para `wrangler secret put` desde archivo)
 * o base64 (una sola línea, ideal para `.dev.vars`). Devuelve siempre PEM.
 */
function decodePem(value: string): string {
  return value.includes("-----BEGIN") ? value : atob(value.trim());
}
