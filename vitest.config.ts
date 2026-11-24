import { defineConfig } from "vitest/config";

// Los tests de repos/migraciones comparten la base local (:5499): en paralelo se
// pisan entre archivos y falla un test al azar. Por eso los archivos van en serie.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
