// api-sistema-central/src/workers/embedding-calculator.test.ts
//
// Test del mapeo source → tabla. No requiere base: `tableForSource` es una
// función pura extraída del if/else que decidía a qué tabla escribir el
// UPDATE dentro del loop de `recalculateEmbeddings`.

import { describe, expect, it } from "vitest";
import { tableForSource } from "./embedding-calculator";

describe("tableForSource", () => {
  it("mapea cada source a su tabla", () => {
    expect(tableForSource("service")).toBe("service_embeddings");
    expect(tableForSource("activity")).toBe("activity_embeddings");
    expect(tableForSource("training")).toBe("training_embeddings");
  });
});
