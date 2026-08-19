import { describe, expect, it } from "vitest";
import { mapearErrorOpenAI } from "./openai-errors";

describe("mapearErrorOpenAI", () => {
  it("detecta falta de crédito y lo marca como tal", () => {
    const r = mapearErrorOpenAI(429, {
      error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" },
    });
    expect(r.codigo).toBe("insufficient_quota");
    expect(r.esFaltaDeCredito).toBe(true);
    expect(r.mensaje).toContain("sin crédito");
  });

  it("NO confunde rate limit con falta de crédito (los dos son 429)", () => {
    const r = mapearErrorOpenAI(429, {
      error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" },
    });
    expect(r.codigo).toBe("rate_limit_exceeded");
    expect(r.esFaltaDeCredito).toBe(false);
    expect(r.mensaje).toContain("Esperá");
  });

  it("traduce la key inválida", () => {
    const r = mapearErrorOpenAI(401, {
      error: { message: "Incorrect API key provided", code: "invalid_api_key" },
    });
    expect(r.codigo).toBe("invalid_api_key");
    expect(r.esFaltaDeCredito).toBe(false);
    expect(r.mensaje).toContain("no es válida");
  });

  it("traduce el modelo inexistente", () => {
    const r = mapearErrorOpenAI(404, {
      error: { message: "The model does not exist", code: "model_not_found" },
    });
    expect(r.codigo).toBe("model_not_found");
    expect(r.mensaje).toContain("modelo");
  });

  it("usa `type` cuando no viene `code`", () => {
    const r = mapearErrorOpenAI(429, {
      error: { message: "quota", type: "insufficient_quota" },
    });
    expect(r.esFaltaDeCredito).toBe(true);
  });

  it("ante un error desconocido da un mensaje genérico y conserva el detalle", () => {
    const r = mapearErrorOpenAI(500, { error: { message: "Internal server error" } });
    expect(r.codigo).toBe("desconocido");
    expect(r.esFaltaDeCredito).toBe(false);
    expect(r.detalle).toContain("Internal server error");
  });

  it("no explota si el cuerpo es un string sin JSON", () => {
    const r = mapearErrorOpenAI(502, "<html>Bad Gateway</html>");
    expect(r.codigo).toBe("desconocido");
    expect(r.detalle).toContain("Bad Gateway");
  });

  it("acepta el cuerpo como string JSON", () => {
    const r = mapearErrorOpenAI(429, JSON.stringify({ error: { code: "insufficient_quota" } }));
    expect(r.esFaltaDeCredito).toBe(true);
  });
});
