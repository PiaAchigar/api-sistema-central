import { describe, expect, it } from "vitest";
import {
  fechaCorta,
  notasConAplazo,
  origenYAplazos,
  razonesParaNoAplazar,
  razonesParaNoAplazarCompra,
} from "./aplazo-de-vencimiento";

const d = (iso: string) => new Date(iso);
const HOY = d("2026-09-10T12:00:00Z");
const acreditacion = (vence: string | null) => ({
  venceEl: vence ? d(vence) : null,
  esAcreditacion: true,
});

describe("fechaCorta", () => {
  it("es dd/mm/aaaa", () => {
    expect(fechaCorta(d("2026-07-09T18:03:10Z"))).toBe("09/07/2026");
  });
});

describe("razonesParaNoAplazar", () => {
  it("un saldo vencido se puede aplazar a una fecha futura", () => {
    expect(razonesParaNoAplazar(acreditacion("2026-07-09T10:00:00Z"), d("2026-12-12T10:00:00Z"), HOY))
      .toEqual([]);
  });

  it("un saldo que todavía no venció también, si la fecha va para adelante", () => {
    // Estirar antes de que venza es el mismo movimiento, y esperar a que
    // venza para poder estirarlo sería una regla sin motivo.
    expect(razonesParaNoAplazar(acreditacion("2026-11-01T10:00:00Z"), d("2027-02-01T10:00:00Z"), HOY))
      .toEqual([]);
  });

  it("no se puede aplazar al pasado", () => {
    const r = razonesParaNoAplazar(acreditacion("2026-07-09T10:00:00Z"), d("2026-08-01T10:00:00Z"), HOY);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/posterior a hoy/i);
  });

  it("no se puede usar para ACORTAR un plazo vigente", () => {
    // Aplazar corre la fecha para adelante. Acortar es otra cosa y no la
    // hicimos: sin esta guarda, el mismo botón le sacaría tiempo a la clienta.
    const r = razonesParaNoAplazar(acreditacion("2027-01-01T10:00:00Z"), d("2026-12-01T10:00:00Z"), HOY);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/ya vence el 01\/01\/2027/i);
  });

  it("un saldo sin vencimiento no tiene nada que aplazar", () => {
    const r = razonesParaNoAplazar(acreditacion(null), d("2026-12-12T10:00:00Z"), HOY);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/no tiene fecha de vencimiento/i);
  });

  it("un consumo no se aplaza", () => {
    const r = razonesParaNoAplazar(
      { venceEl: null, esAcreditacion: false },
      d("2026-12-12T10:00:00Z"),
      HOY,
    );
    expect(r[0]).toMatch(/no es una acreditación/i);
  });

  it("un saldo sin fecha no suma además el error de 'ya vence'", () => {
    // Dos mensajes para el mismo problema mandan a Laura a buscar dos causas.
    const r = razonesParaNoAplazar(acreditacion(null), d("2026-12-12T10:00:00Z"), HOY);
    expect(r).toHaveLength(1);
  });
});

describe("notasConAplazo", () => {
  const ORIGEN = 'Cancelación de "Alpha Synergy — pack de 4"';

  it("deja el origen intacto y agrega el aplazo detrás", () => {
    const r = notasConAplazo(ORIGEN, d("2026-07-09T10:00:00Z"), d("2026-12-12T10:00:00Z"), "estuvo internada");
    expect(r).toBe(`${ORIGEN} | Aplazado del 09/07/2026 al 12/12/2026: estuvo internada`);
  });

  it("el motivo es opcional", () => {
    const r = notasConAplazo(ORIGEN, d("2026-07-09T10:00:00Z"), d("2026-12-12T10:00:00Z"), null);
    expect(r).toBe(`${ORIGEN} | Aplazado del 09/07/2026 al 12/12/2026`);
  });

  it("un motivo en blanco no deja los dos puntos colgando", () => {
    const r = notasConAplazo(ORIGEN, d("2026-07-09T10:00:00Z"), d("2026-12-12T10:00:00Z"), "   ");
    expect(r).toBe(`${ORIGEN} | Aplazado del 09/07/2026 al 12/12/2026`);
  });

  it("aplazar dos veces deja las dos líneas: la cadena es el historial", () => {
    const uno = notasConAplazo(ORIGEN, d("2026-07-09T10:00:00Z"), d("2026-10-01T10:00:00Z"), null);
    const dos = notasConAplazo(uno, d("2026-10-01T10:00:00Z"), d("2026-12-12T10:00:00Z"), "última vez");
    expect(origenYAplazos(dos).aplazos).toHaveLength(2);
  });
});

describe("origenYAplazos", () => {
  it("separa el origen de su historial", () => {
    const notas = 'Cancelación de "Alpha Synergy" | Aplazado del 09/07/2026 al 12/12/2026: internada';
    expect(origenYAplazos(notas)).toEqual({
      origen: 'Cancelación de "Alpha Synergy"',
      aplazos: ["Aplazado del 09/07/2026 al 12/12/2026: internada"],
    });
  });

  it("sin aplazos, el origen es todo el texto", () => {
    expect(origenYAplazos("Cancelación")).toEqual({ origen: "Cancelación", aplazos: [] });
  });

  it("sin notas no rompe", () => {
    expect(origenYAplazos(null)).toEqual({ origen: null, aplazos: [] });
  });
});

describe("razonesParaNoAplazarCompra", () => {
  const compra = (vence: string | null, cancelada = false) => ({
    venceEl: vence ? d(vence) : null,
    cancelada,
  });

  it("una compra cancelada no se aplaza", () => {
    expect(
      razonesParaNoAplazarCompra(compra("2026-10-01T10:00:00Z", true), d("2026-12-12T10:00:00Z"), HOY),
    ).toEqual(["Esta compra está cancelada."]);
  });

  it("sin fecha de vencimiento no hay nada que aplazar", () => {
    expect(razonesParaNoAplazarCompra(compra(null), d("2026-12-12T10:00:00Z"), HOY)).toEqual([
      "Esta compra no tiene fecha de vencimiento, así que no hay nada que aplazar.",
    ]);
  });

  it("la fecha nueva tiene que ser posterior a hoy", () => {
    expect(razonesParaNoAplazarCompra(compra("2026-10-01T10:00:00Z"), d("2026-09-01T10:00:00Z"), HOY)).toEqual([
      "La fecha nueva tiene que ser posterior a hoy.",
    ]);
  });

  it("aplazar es para adelante: no alcanza con ser posterior a hoy", () => {
    expect(razonesParaNoAplazarCompra(compra("2026-12-12T10:00:00Z"), d("2026-10-01T10:00:00Z"), HOY)).toEqual([
      "Aplazar es correr la fecha para adelante. Esta compra ya vence el 12/12/2026.",
    ]);
  });

  it("vencida pero no cancelada se puede aplazar", () => {
    expect(razonesParaNoAplazarCompra(compra("2026-08-01T10:00:00Z"), d("2026-12-12T10:00:00Z"), HOY)).toEqual([]);
  });
});
