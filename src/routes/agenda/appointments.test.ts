import { describe, expect, it } from "vitest";
import { appointmentsRouter, createBody } from "./appointments";

describe("el cuerpo del turno nuevo", () => {
  /**
   * V3b (Task 5): lo que el turno descuenta al agendar es un servicio
   * comprado sin fecha todavía — no una sesión, que es justamente lo que
   * este turno le da al confirmarse. El campo del body sigue ese vocabulario.
   */
  it("acepta customerPurchaseServiceId", () => {
    const ok = createBody.safeParse({
      customerId: "11111111-1111-1111-1111-111111111111",
      serviceId: "22222222-2222-2222-2222-222222222222",
      providerId: "33333333-3333-3333-3333-333333333333",
      start: "2026-09-20T13:00:00.000Z",
      customerPurchaseServiceId: "44444444-4444-4444-4444-444444444444",
    });
    expect(ok.success).toBe(true);
    // z.object() sin .strict() descarta claves desconocidas en vez de
    // rechazarlas: un success:true no alcanza para probar que el campo
    // existe en el schema. Hay que ver que sobrevive el parseo.
    if (ok.success) {
      expect(ok.data.customerPurchaseServiceId).toBe("44444444-4444-4444-4444-444444444444");
    }
  });

  /**
   * Ronda de arreglos 3 (Critical 2). El selector de sexo del modal de turno
   * (§3.3a) viajaba en el `GET /para-agendar?sexo=` pero NO en el POST, así
   * que el servidor recalculaba la duración con el sexo de la ficha: la
   * pantalla mostraba 15 min y la base guardaba 12.
   *
   * Por el mismo motivo que el test de arriba, no alcanza con `success:
   * true` — sin el campo en el schema, `z.object()` lo descarta en silencio y
   * el POST "funciona" perdiendo el dato.
   */
  it("acepta sexo y lo deja pasar", () => {
    const ok = createBody.safeParse({
      customerId: "11111111-1111-1111-1111-111111111111",
      serviceId: "22222222-2222-2222-2222-222222222222",
      providerId: "33333333-3333-3333-3333-333333333333",
      start: "2026-09-20T13:00:00.000Z",
      customerPurchaseServiceId: "44444444-4444-4444-4444-444444444444",
      zonas: ["55555555-5555-5555-5555-555555555555"],
      sexo: "hombre",
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.sexo).toBe("hombre");
  });

  it("rechaza un sexo que no es ninguno de los dos", () => {
    const mal = createBody.safeParse({
      customerId: "11111111-1111-1111-1111-111111111111",
      serviceId: "22222222-2222-2222-2222-222222222222",
      providerId: "33333333-3333-3333-3333-333333333333",
      start: "2026-09-20T13:00:00.000Z",
      sexo: "otro",
    });
    expect(mal.success).toBe(false);
  });
});

describe("el orden de las rutas", () => {
  /**
   * Hono resuelve por ORDEN DE REGISTRO. Si `/:id` se registra antes que
   * `/consumible`, la consulta de qué se descuenta entra por el comodín con
   * id="consumible" y devuelve un 404 — sin error, sin aviso: la pantalla de
   * turno nuevo simplemente nunca ofrecería descontar del pack.
   *
   * Ya pasó dos veces en este repo (`/credits/expired`, `/admin/tarifarios`).
   */
  it("/consumible va ANTES del comodín /:id", () => {
    const gets = appointmentsRouter.routes.filter((r) => r.method === "GET").map((r) => r.path);
    const comodin = gets.indexOf("/:id");
    const consumible = gets.indexOf("/consumible");

    expect(comodin).toBeGreaterThanOrEqual(0);
    expect(consumible).toBeGreaterThanOrEqual(0);
    expect(consumible).toBeLessThan(comodin);
  });
});
