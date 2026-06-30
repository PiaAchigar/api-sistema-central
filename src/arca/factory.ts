import type { AppBindings } from "../env";
import { AfipArcaClient } from "./afip-client";
import { MockArcaClient } from "./mock-client";
import type { ArcaClient } from "./types";

export type ArcaConfig = {
  client: ArcaClient;
  pointOfSale: number;
  invoiceType: string;
};

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
    };
  }

  return {
    client: new MockArcaClient(env.ARCA_MOCK_FAIL === "true"),
    pointOfSale,
    invoiceType,
  };
}

/**
 * Acepta PEM crudo (multilínea, ideal para `wrangler secret put` desde archivo)
 * o base64 (una sola línea, ideal para `.dev.vars`). Devuelve siempre PEM.
 */
function decodePem(value: string): string {
  return value.includes("-----BEGIN") ? value : atob(value.trim());
}
