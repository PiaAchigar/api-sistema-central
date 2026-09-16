import { describe, expect, it } from "vitest";
import { gananciaDelTurno } from "./pago-de-promo";

const acuerdo = { paymentType: "fixed_per_service" as const, rate: 8000 };

describe("gananciaDelTurno", () => {
  it("con pago de promo, ese monto pisa al acuerdo", () => {
    // Laura negoció con la proveedora un pago especial mientras el servicio
    // está en promo. Ese acuerdo es el que vale ese día.
    expect(gananciaDelTurno(12000, acuerdo, 0, 0)).toEqual({
      providerPaymentType: "promo",
      providerRate: null,
      providerEarning: "12000.00",
    });
  });

  it("sin pago de promo, rige el acuerdo de siempre", () => {
    // providerRate es una columna `decimal`: Drizzle la mapea a string, no a
    // número (ver src/db/schema/agenda.ts:304). El snapshot tiene que quedar
    // con el mismo tipo que espera la base.
    expect(gananciaDelTurno(null, acuerdo, 0, 0)).toEqual({
      providerPaymentType: "fixed_per_service",
      providerRate: "8000.00",
      providerEarning: "8000.00",
    });
  });

  it("un pago de promo de cero es un pago, no un 'sin pago'", () => {
    // Laura puede acordar que ese servicio en promo no se le paga. Tratarlo
    // como "no hay acuerdo" le pagaría el precio normal.
    expect(gananciaDelTurno(0, acuerdo, 0, 0).providerEarning).toBe("0.00");
  });

  it("sin pago de promo y sin acuerdo, no se congela nada", () => {
    expect(gananciaDelTurno(null, null, 0, 0)).toEqual({});
  });

  it("por hora: el acuerdo usa la duración", () => {
    expect(
      gananciaDelTurno(null, { paymentType: "per_hour", rate: 6000 }, 90, 0).providerEarning,
    ).toBe("9000.00");
  });

  it("por porcentaje: el acuerdo usa el precio en efectivo del servicio", () => {
    expect(
      gananciaDelTurno(null, { paymentType: "percentage", rate: 50 }, 0, 20000).providerEarning,
    ).toBe("10000.00");
  });
});
