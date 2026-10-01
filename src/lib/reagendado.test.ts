import { describe, expect, it } from "vitest";
import { filaDeReagendado, huboMovimiento } from "./reagendado";

const turno = {
  id: "a1",
  appointmentStart: new Date("2026-09-10T13:00:00Z"),
  appointmentEnd: new Date("2026-09-10T14:00:00Z"),
  durationMinutes: 60,
};

const nuevo = {
  start: new Date("2026-09-12T16:00:00Z"),
  end: new Date("2026-09-12T17:00:00Z"),
  durationMinutes: 60,
};

describe("filaDeReagendado", () => {
  it("guarda la fecha VIEJA en previous, no la nueva", () => {
    // Este es el error que la fila existe para evitar: si `previous` se llena
    // con la fecha nueva, la tabla se ve llena y no sirve para nada.
    const fila = filaDeReagendado(turno, nuevo, {});
    expect(fila.previousStart).toEqual(turno.appointmentStart);
    expect(fila.newStart).toEqual(nuevo.start);
  });

  it("guarda también el fin y la duración de antes", () => {
    const fila = filaDeReagendado(turno, nuevo, {});
    expect(fila.previousEnd).toEqual(turno.appointmentEnd);
    expect(fila.previousDurationMinutes).toBe(60);
  });

  it("apunta a su turno", () => {
    expect(filaDeReagendado(turno, nuevo, {}).appointmentId).toBe("a1");
  });

  it("registra quién lo movió", () => {
    const fila = filaDeReagendado(turno, nuevo, { userId: "u9" });
    expect(fila.rescheduledByUserId).toBe("u9");
  });

  it("sin usuario deja null y no rompe", () => {
    // El endpoint pide auth, pero un job o un script no tienen userId.
    expect(filaDeReagendado(turno, nuevo, {}).rescheduledByUserId).toBeNull();
  });

  it("recorta el motivo", () => {
    const fila = filaDeReagendado(turno, nuevo, { reason: "  la clienta pidió  " });
    expect(fila.reason).toBe("la clienta pidió");
  });

  it("un motivo en blanco es null, no cadena vacía", () => {
    expect(filaDeReagendado(turno, nuevo, { reason: "   " }).reason).toBeNull();
    expect(filaDeReagendado(turno, nuevo, {}).reason).toBeNull();
  });

  it("un turno sin fechas previas no rompe: quedan en null", () => {
    // `appointment_start` es nullable en la base desde init.sql.
    const huerfano = { id: "a2", appointmentStart: null, appointmentEnd: null, durationMinutes: null };
    const fila = filaDeReagendado(huerfano, nuevo, {});
    expect(fila.previousStart).toBeNull();
    expect(fila.previousDurationMinutes).toBeNull();
    expect(fila.newStart).toEqual(nuevo.start);
  });
});

describe("huboMovimiento", () => {
  it("es true si cambia el inicio", () => {
    expect(huboMovimiento(turno, nuevo)).toBe(true);
  });

  it("es false si el turno queda exactamente donde estaba", () => {
    // Confirmar el mismo horario no es un reagendamiento: si esto devolviera
    // true, el historial se llenaría de filas que no cuentan nada.
    const igual = {
      start: turno.appointmentStart,
      end: turno.appointmentEnd,
      durationMinutes: 60,
    };
    expect(huboMovimiento(turno, igual)).toBe(false);
  });

  it("es true si el inicio no cambia pero sí el fin", () => {
    // Pasa cuando cambió la duración del servicio: el turno ocupa otra franja.
    const masLargo = {
      start: turno.appointmentStart,
      end: new Date("2026-09-10T14:30:00Z"),
      durationMinutes: 90,
    };
    expect(huboMovimiento(turno, masLargo)).toBe(true);
  });

  it("un turno sin fecha previa cuenta como movimiento", () => {
    const huerfano = { id: "a2", appointmentStart: null, appointmentEnd: null, durationMinutes: null };
    expect(huboMovimiento(huerfano, nuevo)).toBe(true);
  });
});

describe("con proveedora (reagendar puede cambiar de proveedora)", () => {
  const conA = { ...turno, serviceProviderId: "provA" };

  it("guarda la proveedora VIEJA en previous y la nueva en new", () => {
    const fila = filaDeReagendado(conA, { ...nuevo, providerId: "provB" }, {});
    expect(fila.previousProviderId).toBe("provA");
    expect(fila.newProviderId).toBe("provB");
  });

  it("sin proveedora nueva, new es la misma que la de antes (no se perdió, no cambió)", () => {
    const fila = filaDeReagendado(conA, nuevo, {});
    expect(fila.previousProviderId).toBe("provA");
    expect(fila.newProviderId).toBe("provA");
  });

  it("un turno sin proveedora previa no rompe: previous null, new la nueva", () => {
    const fila = filaDeReagendado(turno, { ...nuevo, providerId: "provB" }, {});
    expect(fila.previousProviderId).toBeNull();
    expect(fila.newProviderId).toBe("provB");
  });

  it("cambiar SÓLO la proveedora (misma franja) es un movimiento", () => {
    // Antes `huboMovimiento` miraba sólo fecha/hora: pasar el turno de Gabi a Lu
    // al mismo horario no dejaba ninguna fila en el historial.
    const mismaFranja = {
      start: turno.appointmentStart,
      end: turno.appointmentEnd,
      durationMinutes: 60,
      providerId: "provB",
    };
    expect(huboMovimiento(conA, mismaFranja)).toBe(true);
  });

  it("la misma proveedora y la misma franja NO es un movimiento", () => {
    const igual = {
      start: turno.appointmentStart,
      end: turno.appointmentEnd,
      durationMinutes: 60,
      providerId: "provA",
    };
    expect(huboMovimiento(conA, igual)).toBe(false);
  });

  it("sin providerId en la franja y misma franja NO es movimiento (el camino de siempre)", () => {
    const igual = { start: turno.appointmentStart, end: turno.appointmentEnd, durationMinutes: 60 };
    expect(huboMovimiento(conA, igual)).toBe(false);
  });
});
