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
    if (!env.AFIP_CUIT || !env.AFIP_SDK_TOKEN) {
      throw new Error(
        "ARCA_MODE=afip requiere los secretos AFIP_CUIT y AFIP_SDK_TOKEN",
      );
    }
    return {
      client: new AfipArcaClient(env.AFIP_CUIT, env.AFIP_SDK_TOKEN),
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
