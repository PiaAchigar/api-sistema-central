// api-sistema-central/src/workers/embedding-calculator.test.ts
//
// Test del mapeo source → tabla. No requiere base: `tableForSource` es una
// función pura extraída del if/else que decidía a qué tabla escribir el
// UPDATE dentro del loop de `recalculateEmbeddings`.

import { describe, expect, it } from "vitest";
import { drenarPendientes, tableForSource } from "./embedding-calculator";

describe("tableForSource", () => {
  it("mapea cada source a su tabla", () => {
    expect(tableForSource("service")).toBe("service_embeddings");
    expect(tableForSource("activity")).toBe("activity_embeddings");
    expect(tableForSource("training")).toBe("training_embeddings");
  });
});

// `db` y `env` no se tocan: todos los tests inyectan `correrLote`.
const db = {} as never;
const env = { CREDENTIALS_ENCRYPTION_KEY: "x" } as never;

/** Lote falso que devuelve `porLote` items exitosos las primeras `veces` llamadas. */
function loteFalso(veces: number, porLote = 10) {
  let llamadas = 0;
  return async () => {
    llamadas++;
    if (llamadas > veces) return { message: "No hay embeddings para recalcular" };
    return {
      processed: porLote,
      results: Array.from({ length: porLote }, (_, i) => ({ id: `${llamadas}-${i}`, status: "success" as const })),
      sinCredito: false,
      fallidos: 0,
    };
  };
}

describe("drenarPendientes", () => {
  it("corta cuando no quedan pendientes", async () => {
    const r = await drenarPendientes(db, env, { correrLote: loteFalso(3) });
    expect(r.motivo).toBe("sin-pendientes");
    expect(r.lotes).toBe(3);
    expect(r.procesados).toBe(30);
  });

  it("corta por el tope de lotes", async () => {
    const r = await drenarPendientes(db, env, { correrLote: loteFalso(999), maxLotes: 4 });
    expect(r.motivo).toBe("tope-lotes");
    expect(r.lotes).toBe(4);
  });

  it("corta por el tope de items", async () => {
    const r = await drenarPendientes(db, env, { correrLote: loteFalso(999), maxItems: 25 });
    expect(r.motivo).toBe("tope-items");
    expect(r.procesados).toBeGreaterThanOrEqual(25);
  });

  it("corta por el tope de tiempo sin esperar de verdad", async () => {
    let t = 0;
    const r = await drenarPendientes(db, env, {
      correrLote: loteFalso(999),
      // Cada consulta del reloj avanza 10 segundos: al tercer lote ya pasó el tope.
      ahora: () => (t += 10_000),
      maxMs: 25_000,
      maxLotes: 999,
    });
    expect(r.motivo).toBe("tope-tiempo");
  });

  it("corta apenas un lote avisa que no hay crédito", async () => {
    const r = await drenarPendientes(db, env, {
      correrLote: async () => ({ processed: 0, results: [], sinCredito: true, fallidos: 0 }),
    });
    expect(r.motivo).toBe("sin-credito");
    expect(r.sinCredito).toBe(true);
    expect(r.lotes).toBe(1);
  });

  it("corta si no hay credencial configurada", async () => {
    const r = await drenarPendientes(db, env, {
      correrLote: async () => ({ error: "No hay credencial de OpenAI activa" }),
    });
    expect(r.motivo).toBe("sin-credencial");
    expect(r.procesados).toBe(0);
  });

  it("corta si un lote no tuvo ni un solo éxito, en vez de repetir el mismo error 10 veces", async () => {
    const r = await drenarPendientes(db, env, {
      correrLote: async () => ({
        processed: 10,
        results: [
          { id: "a", status: "failed" as const, error: "invalid_api_key: la clave no es válida" },
          ...Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, status: "failed" as const, error: "otro error" })),
        ],
        sinCredito: false,
        fallidos: 10,
      }),
    });
    expect(r.motivo).toBe("todos-fallaron");
    expect(r.lotes).toBe(1);
    expect(r.error).toBe("invalid_api_key: la clave no es válida");
  });

  it("no corta si el lote tuvo al menos un éxito, aunque haya fallidos mezclados", async () => {
    let llamadas = 0;
    const r = await drenarPendientes(db, env, {
      correrLote: async () => {
        llamadas++;
        if (llamadas > 2) return { message: "No hay embeddings para recalcular" };
        return {
          processed: 10,
          results: [
            { id: "ok", status: "success" as const },
            ...Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, status: "failed" as const, error: "e" })),
          ],
          sinCredito: false,
          fallidos: 9,
        };
      },
    });
    expect(r.motivo).toBe("sin-pendientes");
    expect(r.lotes).toBe(2);
  });
});
