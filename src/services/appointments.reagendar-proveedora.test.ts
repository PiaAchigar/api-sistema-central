import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  appointments,
  machines,
  service,
  serviceMachine,
  serviceProviderAvailability,
  serviceProviderMachine,
  serviceProviders,
  serviceProviderService,
} from "../db/schema";
import type { Db } from "../db/client";

// El ancla de depilación es GLOBAL en la base: se mockea (como en
// `appointments.sin-ancla.test.ts`) para poder simular "este servicio es de
// depilación" sin tocar la fila real, que otras suites leen en paralelo.
const estado = vi.hoisted(() => ({ ancla: null as string | null }));
vi.mock("../repositories/ancla-de-depilacion.repo", () => ({
  anclaDeDepilacion: async () => {
    if (!estado.ancla) throw new Error("sin ancla");
    return estado.ancla;
  },
  anclaDeDepilacionOpcional: async () => estado.ancla,
}));

const { createAppointment, rescheduleAppointment } = await import("./appointments.service");
const { listReschedules } = await import("../repositories/appointment-reschedule.repo");
const { getAvailability, getMonthAvailability } = await import("./availability.service");

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pgClient = postgres(LOCAL_DB_URL, { max: 1 });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_REAGENDAR_PROV";
const CUSTOMER_ID = "dddddddd-0000-0000-0000-000000000001";

let servicioId: string;
let servicioConMaquinaId: string;
let provA: string;
let provB: string;
let provC: string; // NO ofrece ningún servicio
let maquina1: string;
let maquina2: string;

/** Un lunes a al menos `minDias` días de hoy, como YYYY-MM-DD. `open_hours` abre 09–20 los lunes. */
function proximoLunes(minDias: number): string {
  const d = new Date(Date.now() + minDias * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const LUNES_1 = proximoLunes(14);
const LUNES_2 = proximoLunes(21);
// 13:00Z = 10:00 en Argentina.
const aLas10 = (dia: string) => `${dia}T13:00:00.000Z`;
const aLas11 = (dia: string) => `${dia}T14:00:00.000Z`;

async function limpiar() {
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`)); // cascada a appointment_reschedule
  const provs = await db
    .select({ id: serviceProviders.id })
    .from(serviceProviders)
    .where(like(serviceProviders.fullName, `${QA}%`));
  const provIds = provs.map((p) => p.id);
  const maqs = await db.select({ id: machines.id }).from(machines).where(like(machines.name, `${QA}%`));
  const maqIds = maqs.map((m) => m.id);
  const servs = await db.select({ id: service.id }).from(service).where(like(service.name, `${QA}%`));
  const servIds = servs.map((s) => s.id);
  if (provIds.length > 0) {
    await db.delete(serviceProviderMachine).where(inArray(serviceProviderMachine.serviceProviderId, provIds));
    await db.delete(serviceProviderService).where(inArray(serviceProviderService.serviceProviderId, provIds));
    await db.delete(serviceProviderAvailability).where(inArray(serviceProviderAvailability.serviceProviderId, provIds));
    await db.delete(serviceProviders).where(inArray(serviceProviders.id, provIds));
  }
  if (maqIds.length > 0) {
    await db.delete(serviceMachine).where(inArray(serviceMachine.machineId, maqIds));
    await db.delete(machines).where(inArray(machines.id, maqIds));
  }
  if (servIds.length > 0) await db.delete(service).where(inArray(service.id, servIds));
}

beforeAll(async () => {
  await limpiar();

  const [s1] = await db
    .insert(service)
    .values({ name: `${QA}_SERVICIO`, isActive: true, estimatedDurationMinutes: 30, requiresMachine: false })
    .returning({ id: service.id });
  servicioId = s1!.id;
  const [s2] = await db
    .insert(service)
    .values({ name: `${QA}_SERVICIO_MAQUINA`, isActive: true, estimatedDurationMinutes: 30, requiresMachine: true })
    .returning({ id: service.id });
  servicioConMaquinaId = s2!.id;

  const provs = await db
    .insert(serviceProviders)
    .values([
      { fullName: `${QA}_A`, status: "active" },
      { fullName: `${QA}_B`, status: "active" },
      { fullName: `${QA}_C`, status: "active" },
    ])
    .returning({ id: serviceProviders.id });
  provA = provs[0]!.id;
  provB = provs[1]!.id;
  provC = provs[2]!.id;

  for (const pid of [provA, provB]) {
    for (const sid of [servicioId, servicioConMaquinaId]) {
      await db.insert(serviceProviderService).values({
        serviceProviderId: pid,
        serviceId: sid,
        paymentType: "fixed_per_service",
        rate: "1000",
        isActive: true,
      });
    }
  }
  for (const pid of [provA, provB, provC]) {
    await db.insert(serviceProviderAvailability).values({
      serviceProviderId: pid,
      dayOfWeek: 1,
      workStartTime: "09:00:00",
      workEndTime: "20:00:00",
      isActive: true,
    });
  }

  // Máquinas: A sólo está certificada en la 1, B sólo en la 2.
  const maqs = await db
    .insert(machines)
    .values([
      { name: `${QA}_MAQ1`, status: "active" },
      { name: `${QA}_MAQ2`, status: "active" },
    ])
    .returning({ id: machines.id });
  maquina1 = maqs[0]!.id;
  maquina2 = maqs[1]!.id;
  await db.insert(serviceMachine).values([
    { serviceId: servicioConMaquinaId, machineId: maquina1, isPrimaryMachine: true },
    { serviceId: servicioConMaquinaId, machineId: maquina2, isPrimaryMachine: false },
  ]);
  await db.insert(serviceProviderMachine).values([
    { serviceProviderId: provA, machineId: maquina1 },
    { serviceProviderId: provB, machineId: maquina2 },
  ]);
}, 30000);

afterAll(async () => {
  estado.ancla = null;
  await limpiar();
  await pgClient.end();
});

// Todos los tests usan los mismos horarios de los mismos lunes: sin esto, los
// turnos de un test le ocupan el hueco al siguiente. (Borrar el turno arrastra
// su historial: `appointment_reschedule.appointment_id` es ON DELETE CASCADE.)
beforeEach(async () => {
  await db.delete(appointments).where(like(appointments.notes, `${QA}%`));
});

async function turnoDe(serviceId: string, providerId: string, inicio: string) {
  return createAppointment(db, {
    customerId: CUSTOMER_ID,
    serviceId,
    providerId,
    start: inicio,
    notes: QA,
  });
}

describe("reagendar con proveedora", () => {
  it("1. sin proveedora nueva sigue igual que siempre: sólo mueve la hora, misma proveedora", async () => {
    const t = await turnoDe(servicioId, provA, aLas10(LUNES_1));
    const movido = await rescheduleAppointment(db, t.id, aLas11(LUNES_1));
    expect(movido!.serviceProviderId).toBe(provA);
    expect(movido!.appointmentStart).toEqual(new Date(aLas11(LUNES_1)));
    const hist = await listReschedules(db, t.id);
    expect(hist).toHaveLength(1);
    expect(hist[0]!.previousStart).toEqual(new Date(aLas10(LUNES_1)));
  });

  it("2. cambiar SÓLO la proveedora (mismo día y hora) mueve el turno y deja una fila con los nombres", async () => {
    const t = await turnoDe(servicioId, provA, aLas10(LUNES_1));
    const movido = await rescheduleAppointment(db, t.id, aLas10(LUNES_1), {}, provB);
    expect(movido!.serviceProviderId).toBe(provB);
    expect(movido!.appointmentStart).toEqual(new Date(aLas10(LUNES_1)));
    const hist = await listReschedules(db, t.id);
    expect(hist).toHaveLength(1);
    expect(hist[0]!.previousProviderName).toBe(`${QA}_A`);
    expect(hist[0]!.newProviderName).toBe(`${QA}_B`);
  });

  it("3. cambiar proveedora Y horario a la vez deja UNA sola fila con los cuatro datos", async () => {
    const t = await turnoDe(servicioId, provA, aLas10(LUNES_1));
    await rescheduleAppointment(db, t.id, aLas11(LUNES_2), { reason: "pidió con Lu" }, provB);
    const hist = await listReschedules(db, t.id);
    expect(hist).toHaveLength(1);
    expect(hist[0]!.previousStart).toEqual(new Date(aLas10(LUNES_1)));
    expect(hist[0]!.newStart).toEqual(new Date(aLas11(LUNES_2)));
    expect(hist[0]!.previousProviderName).toBe(`${QA}_A`);
    expect(hist[0]!.newProviderName).toBe(`${QA}_B`);
    expect(hist[0]!.reason).toBe("pidió con Lu");
  });

  it("4. una proveedora que NO ofrece el servicio se rechaza y el turno queda como estaba", async () => {
    const t = await turnoDe(servicioId, provA, aLas10(LUNES_1));
    await expect(rescheduleAppointment(db, t.id, aLas10(LUNES_1), {}, provC)).rejects.toThrow(
      /proveedora no está disponible/i,
    );
    const [despues] = await db.select().from(appointments).where(eq(appointments.id, t.id));
    expect(despues!.serviceProviderId).toBe(provA);
    expect(await listReschedules(db, t.id)).toHaveLength(0);
  });

  it("5. una proveedora ocupada a esa hora se rechaza (409) y el turno queda como estaba", async () => {
    await turnoDe(servicioId, provB, aLas10(LUNES_2)); // B ocupada el lunes 2 a las 10
    const t = await turnoDe(servicioId, provA, aLas10(LUNES_1));
    await expect(rescheduleAppointment(db, t.id, aLas10(LUNES_2), {}, provB)).rejects.toThrow(
      /no tiene ese horario disponible/i,
    );
    const [despues] = await db.select().from(appointments).where(eq(appointments.id, t.id));
    expect(despues!.serviceProviderId).toBe(provA);
    expect(despues!.appointmentStart).toEqual(new Date(aLas10(LUNES_1)));
  });

  it("6. con máquina: al pasar a otra proveedora, la máquina se recalcula sola", async () => {
    const t = await turnoDe(servicioConMaquinaId, provA, aLas10(LUNES_1));
    expect(t.machineId).toBe(maquina1); // A sólo está certificada en la 1
    const movido = await rescheduleAppointment(db, t.id, aLas10(LUNES_1), {}, provB);
    expect(movido!.serviceProviderId).toBe(provB);
    expect(movido!.machineId).toBe(maquina2); // B sólo en la 2
  });

  it("7. depilación: cambiar de proveedora se rechaza (400) aunque la otra esté libre", async () => {
    const t = await turnoDe(servicioId, provA, aLas10(LUNES_1));
    estado.ancla = servicioId; // desde acá, ese servicio es "el ancla de depilación"
    try {
      await expect(rescheduleAppointment(db, t.id, aLas10(LUNES_1), {}, provB)).rejects.toThrow(
        /depilación/i,
      );
      const [despues] = await db.select().from(appointments).where(eq(appointments.id, t.id));
      expect(despues!.serviceProviderId).toBe(provA);
    } finally {
      estado.ancla = null;
    }
  });
});

describe("reagendar con la MISMA proveedora: la máquina también se revisa", () => {
  // Antes, sin cambio de proveedora la máquina no se miraba: el turno se movía
  // con la misma máquina aunque otra clienta la tuviera tomada a esa hora. La
  // pantalla ofrece el horario si CUALQUIER máquina certificada está libre, así
  // que se llegaba desde la agenda, no sólo por API.

  /** Ocupa una máquina a las 11 del LUNES_2 con un turno de otra proveedora. */
  async function ocuparMaquina(machineId: string) {
    await db.insert(appointments).values({
      serviceProviderId: provB,
      serviceId: servicioConMaquinaId,
      machineId,
      appointmentStart: new Date(aLas11(LUNES_2)),
      appointmentEnd: new Date(`${LUNES_2}T14:30:00.000Z`),
      durationMinutes: 30,
      status: "scheduled",
      notes: QA,
    });
  }

  it("si su máquina está ocupada en el horario nuevo y no tiene otra, se rechaza", async () => {
    const t = await turnoDe(servicioConMaquinaId, provA, aLas10(LUNES_1));
    expect(t.machineId).toBe(maquina1);
    await ocuparMaquina(maquina1);
    await expect(rescheduleAppointment(db, t.id, aLas11(LUNES_2))).rejects.toThrow(
      /no hay máquina disponible/i,
    );
    const [despues] = await db.select().from(appointments).where(eq(appointments.id, t.id));
    expect(despues!.appointmentStart).toEqual(new Date(aLas10(LUNES_1)));
  });

  it("si su máquina está ocupada pero tiene otra certificada libre, pasa a esa", async () => {
    await db.insert(serviceProviderMachine).values({ serviceProviderId: provA, machineId: maquina2 });
    try {
      const t = await turnoDe(servicioConMaquinaId, provA, aLas10(LUNES_1));
      expect(t.machineId).toBe(maquina1); // la primaria
      await ocuparMaquina(maquina1);
      const movido = await rescheduleAppointment(db, t.id, aLas11(LUNES_2));
      expect(movido!.serviceProviderId).toBe(provA);
      expect(movido!.machineId).toBe(maquina2);
    } finally {
      await db
        .delete(serviceProviderMachine)
        .where(
          and(eq(serviceProviderMachine.serviceProviderId, provA), eq(serviceProviderMachine.machineId, maquina2)),
        );
    }
  });

  it("si su máquina está libre, se queda con la misma", async () => {
    const t = await turnoDe(servicioConMaquinaId, provA, aLas10(LUNES_1));
    const movido = await rescheduleAppointment(db, t.id, aLas11(LUNES_2));
    expect(movido!.machineId).toBe(maquina1);
  });
});

describe("disponibilidad para reagendar un turno de depilación", () => {
  // El ancla de depilación tiene una duración de RELLENO (30 min) en el
  // catálogo; la real es la que el turno guardó al crearse (la suma de sus
  // zonas). Si el calendario y el select de hora calculan con 30, ofrecen
  // horarios que `rescheduleAppointment` (que valida con la real) rechaza.
  it("usa la duración guardada del turno, no la del ancla", async () => {
    const t = await turnoDe(servicioId, provA, aLas10(LUNES_1));
    await db.update(appointments).set({ durationMinutes: 90 }).where(eq(appointments.id, t.id));
    estado.ancla = servicioId;
    try {
      const r = await getAvailability(db, servicioId, LUNES_1, provA, t.id);
      expect(r.durationMinutes).toBe(90);
      expect(r.slots.find((s) => s.start === "10:00")?.end).toBe("11:30");
      // La prestadora trabaja hasta las 20: lo último que entra son 90 min desde las 18:30.
      expect(r.slots.at(-1)?.start).toBe("18:30");

      // El calendario usa el mismo cálculo.
      const mes = await getMonthAvailability(db, servicioId, provA, LUNES_1.slice(0, 7), t.id);
      expect(mes.availableDays).toContain(LUNES_1);
    } finally {
      estado.ancla = null;
    }
  });

  it("un servicio que no es depilación sigue con la duración del catálogo", async () => {
    const t = await turnoDe(servicioId, provA, aLas10(LUNES_1));
    await db.update(appointments).set({ durationMinutes: 90 }).where(eq(appointments.id, t.id));
    const r = await getAvailability(db, servicioId, LUNES_1, provA, t.id);
    expect(r.durationMinutes).toBe(30);
  });
});
