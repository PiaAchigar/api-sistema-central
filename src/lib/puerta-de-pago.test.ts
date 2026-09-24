import { describe, expect, it } from "vitest";
import { puertaDePago } from "./puerta-de-pago";

const pack = (pagado: number, sesionesLibres: number) => ({
  finalAmount: 135000, pagado, esPaquete: false,
  sesionesTotales: 3, sesionesLibres,
});

describe("puertaDePago", () => {
  it("reservar siempre se puede: es guardar el lugar, no cobrar", () => {
    expect(puertaDePago(pack(0, 3)).puedeReservar).toBe(true);
  });

  it("sin pagar nada no se agenda, y dice cuánto falta", () => {
    const p = puertaDePago(pack(0, 3));
    expect(p.puedeAgendar).toBe(false);
    expect(p.faltaCobrar).toBe(54000); // el 40%
    expect(p.motivo).toMatch(/40%/);
  });

  it("con el 40% se agendan las primeras sesiones", () => {
    const p = puertaDePago(pack(54000, 3));
    expect(p.puedeAgendar).toBe(true);
    expect(p.motivo).toBeNull();
  });

  /**
   * La última sesión libre exige estar al día. Le da a Laura una palanca
   * natural para cobrar el saldo antes de cerrar el tratamiento, en vez de
   * descubrir seis meses después que entregó tres sesiones por el 40%.
   */
  it("la ÚLTIMA sesión libre exige el 100%", () => {
    const conDeuda = puertaDePago(pack(54000, 1));
    expect(conDeuda.puedeAgendar).toBe(false);
    expect(conDeuda.faltaCobrar).toBe(81000);
    expect(conDeuda.motivo).toMatch(/última sesión/i);

    const alDia = puertaDePago(pack(135000, 1));
    expect(alDia.puedeAgendar).toBe(true);
  });

  /**
   * Una compra de UNA sola sesión es a la vez la primera y la última, así que
   * las dos reglas dan lo mismo: un servicio suelto se paga entero.
   */
  it("un servicio suelto de una sesión se paga entero", () => {
    const suelto = { finalAmount: 17000, esPaquete: false, sesionesTotales: 1, sesionesLibres: 1 };
    expect(puertaDePago({ ...suelto, pagado: 6800 }).puedeAgendar).toBe(false);
    expect(puertaDePago({ ...suelto, pagado: 17000 }).puedeAgendar).toBe(true);
  });

  /**
   * Review Focus #4. La depilación que vino en un paquete de promo se rige por
   * la regla de promo (40%), aunque su `depilation_combo_id` esté en la línea
   * y no en la cabecera.
   */
  it("un paquete de promo se agenda con el 40%, igual que un pack", () => {
    const p = puertaDePago({
      finalAmount: 250000, pagado: 100000, esPaquete: true,
      sesionesTotales: 3, sesionesLibres: 3,
    });
    expect(p.puedeAgendar).toBe(true);
  });

  it("pagado de más no rompe nada", () => {
    expect(puertaDePago(pack(200000, 1)).puedeAgendar).toBe(true);
    expect(puertaDePago(pack(200000, 1)).faltaCobrar).toBe(0);
  });
});
