import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { appointmentBodyZone } from "../db/schema";
import { badRequest, conflict, notFound } from "../lib/errors";
import { subtractAll, type Interval } from "../lib/intervals";
import type { Sexo } from "../lib/depilation-pricing";
import { minutosElegidos, regalosElegidos } from "../lib/menu-de-zonas";
import {
  filaDeReagendado,
  huboMovimiento,
  type QuienYPorQue,
} from "../lib/reagendado";
import { localDayRangeUtc, utcToLocalDateString, utcToLocalMinutes } from "../lib/time";
import {
  getAppointmentById,
  getOverlappingAppointments,
  insertAppointment,
  listAppointmentsByRange,
  updateAppointment,
} from "../repositories/appointments.repo";
import { recordReschedule } from "../repositories/appointment-reschedule.repo";
import { anclaDeDepilacionOpcional } from "../repositories/ancla-de-depilacion.repo";
import { creditCustomer, getCustomerById } from "../repositories/customers.repo";
import { cancelDeal, getDealByAppointmentId } from "../repositories/deals.repo";
import { getActiveAgreement } from "../repositories/providers.repo";
import { getServiceById } from "../repositories/services.repo";
import { datosParaAgendar, puertaDeLaReserva } from "../repositories/turno-de-depilacion.repo";
import { gananciaDelTurno } from "./pago-de-promo";
import { loadAvailabilityContext } from "./availability.service";
import { consumirInsumos } from "./consumo.service";
import {
  consumirServicioDelTurno,
  tomarLineaDeDepilacion,
  tomarServicio,
} from "../repositories/consumo.repo";
import { registerDeposit, type DepositInput } from "./deposits.service";
import type { ArcaConfig } from "../arca/factory";

export type CreateAppointmentInput = {
  customerId: string;
  serviceId: string;
  providerId: string;
  machineId?: string;
  start: string; // ISO datetime
  priceMode?: "list" | "cash";
  notes?: string;
  status?: "scheduled" | "reserved";
  expiryMinutes?: number; // solo para status='reserved'; default 60
  /** Seña cobrada al reservar: se factura a ARCA y queda a favor del cliente. */
  deposit?: DepositInput;
  /**
   * El servicio comprado (sin fecha todavía) que este turno descuenta (V3b).
   *
   * Ausente = el turno no descuenta nada y se cobra aparte, que es el caso más
   * común. La pantalla lo completa sola cuando la clienta tiene UNA sola compra
   * con servicios libres para este servicio; con varias, lo elige Laura
   * (reglas §3.8). Al confirmarse el turno, ese servicio comprado pasa a ser
   * una sesión — recién ahí tiene fecha y hora.
   */
  customerPurchaseServiceId?: string;
  /**
   * Las zonas que se hacen en este turno de depilación (1.56.0).
   *
   * Sólo tiene sentido con `serviceId` = el servicio ancla. La duración del
   * turno sale de acá y NO del presupuesto del pack: si la clienta se hace 39
   * de sus 60 minutos, la agenda bloquea 39 y los otros 21 quedan libres para
   * otra persona. El sobrante no se guarda a favor: la sesión se gastó.
   */
  zonas?: string[];
  /**
   * Con qué sexo se presupuestó esta sesión de depilación (1.56.0, §3.3a).
   *
   * Ausente = el de la ficha de la clienta (`sexoDeLaClienta`; NULL ⇒ mujer),
   * que es el caso normal. La pantalla lo manda cuando Laura pisó el selector
   * —"esta clienta es un hombre aunque la ficha no lo diga"— y el servidor NO
   * le cree el resultado: recalcula todo, pero con el MISMO sexo. Sin esto,
   * la pantalla mostraba 15 min y la base guardaba 12.
   */
  sexo?: Sexo;
};

export async function createAppointment(
  db: Db,
  input: CreateAppointmentInput,
  arca?: ArcaConfig,
) {
  if (input.deposit && !arca) throw badRequest("Config ARCA requerida para señas");
  const startDate = new Date(input.start);
  if (Number.isNaN(startDate.getTime())) throw badRequest("Fecha de inicio inválida");
  if (startDate.getTime() < Date.now()) throw badRequest("El turno no puede ser en el pasado");

  // `...Opcional` y no la que tira: si la 1.56.0 todavía no se aplicó, "no
  // hay ancla" significa "ningún turno es de depilación" y el turnero del
  // salón sigue andando. Ver `ancla-de-depilacion.repo.ts`.
  const ancla = await anclaDeDepilacionOpcional(db);
  const esDepilacion = ancla != null && input.serviceId === ancla;

  if (esDepilacion) {
    if (!input.customerPurchaseServiceId) {
      throw badRequest("Un turno de depilación sale de una sesión comprada: falta cuál");
    }
    if (!input.zonas?.length) {
      throw badRequest("Hay que elegir al menos una zona para el turno");
    }
  } else if (input.zonas?.length) {
    throw badRequest("Sólo un turno de depilación lleva zonas");
  }

  const customer = await getCustomerById(db, input.customerId);
  if (!customer) throw notFound("Customer");

  const localDate = utcToLocalDateString(startDate);
  // El contexto ya valida: proveedora activa con acuerdo vigente, horario del local,
  // disponibilidad del día (semana/sábado), excepciones y turnos existentes.
  const ctx = await loadAvailabilityContext(db, input.serviceId, localDate, input.providerId);
  if (!ctx.open) throw conflict("El local está cerrado ese día");
  if (ctx.providers.length === 0) {
    throw conflict("La proveedora no está disponible para este servicio en esa fecha");
  }

  // Para depilación, la duración sale de las zonas ELEGIDAS y no de
  // `service.estimated_duration_minutes` (que es lo que usa cualquier otro
  // servicio, sin tocar). Se valida contra `datosParaAgendar` — la MISMA
  // cuenta que ya usó la pantalla para armar el menú — para que servidor y
  // pantalla nunca calculen distinto.
  let durationMinutes = ctx.durationMinutes;
  let zonasParaGuardar: { bodyZoneId: string; minutos: number }[] = [];
  if (esDepilacion) {
    const datos = await datosParaAgendar(db, input.customerPurchaseServiceId!, input.sexo);
    const menuPorId = new Map(datos.zonas.map((z) => [z.id, z]));
    for (const zonaId of input.zonas!) {
      const zonaMenu = menuPorId.get(zonaId);
      if (!zonaMenu || !zonaMenu.disponible) {
        throw badRequest("Esa zona no está disponible para este pack");
      }
    }
    durationMinutes = minutosElegidos(datos.zonas, input.zonas!);
    if (durationMinutes > datos.presupuestoMinutos) {
      throw badRequest("Las zonas elegidas no entran en el presupuesto del pack");
    }

    // El tope de zonas "a elección" (spec §7.2: **hasta** N). El presupuesto
    // de minutos NO alcanza para contenerlo: "Combo de Esenciales" (2 grandes
    // + 3 chicas + 1 a elección, 30') deja tildar las 2 grandes y 4 chicas de
    // regalo —30 ≤ 30, pasa— y la clienta se lleva 4 zonas de regalo en vez
    // de 1. La pantalla también lo aplica, pero la verdad vive acá.
    const regalos = regalosElegidos(datos.zonas, input.zonas!);
    if (regalos > datos.zonasDeRegalo) {
      throw badRequest(
        datos.zonasDeRegalo === 0
          ? "Este pack no incluye zonas a elección"
          : `Este pack incluye hasta ${datos.zonasDeRegalo} zona${datos.zonasDeRegalo === 1 ? "" : "s"} a elección`,
      );
    }

    // La puerta de pago (Task 13): reservar guarda el lugar sin cobrar nada,
    // pero agendar exige estar al día. Se evalúa de nuevo acá y no se confía
    // en la pantalla: entre que Laura abrió el modal y apretó el botón, otra
    // pestaña pudo haber devuelto plata. `datos` ya salió de una lectura
    // fresca de `datosParaAgendar` para ESTE request, así que no hace falta
    // volver a consultarla.
    if (input.status !== "reserved" && !datos.puerta.puedeAgendar) {
      throw badRequest(`${datos.puerta.motivo} (falta $${datos.puerta.faltaCobrar})`);
    }

    zonasParaGuardar = input.zonas!.map((id) => ({
      bodyZoneId: id,
      // Congelado: si mañana Laura cambia la config, este turno no cambia de
      // duración solo.
      minutos: menuPorId.get(id)!.minutos,
    }));
  }

  const startMin = utcToLocalMinutes(startDate);
  const requested: Interval = { start: startMin, end: startMin + durationMinutes };
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);

  const freeWindows = ctx.freeWindowsByProvider.get(input.providerId) ?? [];
  const fitsProvider = freeWindows.some(
    (w) => requested.start >= w.start && requested.end <= w.end,
  );
  if (!fitsProvider) {
    throw conflict("La proveedora no tiene ese horario disponible");
  }

  // Máquina: la pedida debe estar certificada y libre; si no se pidió, se elige
  // automáticamente la primera certificada libre (primaria primero)
  let machineId: string | null = null;
  if (ctx.requiresMachine) {
    const candidates = ctx.machinesByProvider.get(input.providerId) ?? [];
    const isMachineFree = (mid: string) => {
      const free = subtractAll(freeWindows, ctx.busyByMachine.get(mid) ?? []);
      return free.some((w) => requested.start >= w.start && requested.end <= w.end);
    };
    if (input.machineId) {
      if (!candidates.includes(input.machineId)) {
        throw conflict("La proveedora no está certificada en esa máquina");
      }
      if (!isMachineFree(input.machineId)) {
        throw conflict("La máquina está ocupada en ese horario");
      }
      machineId = input.machineId;
    } else {
      machineId = candidates.find(isMachineFree) ?? null;
      if (!machineId) throw conflict("No hay máquina disponible en ese horario");
    }
  }

  const servicePrice =
    input.priceMode === "cash" ? ctx.service.unitPriceCash : ctx.service.unitPriceList;

  // Re-chequeo de solapamiento dentro de la transacción para mitigar carreras
  return db.transaction(async (tx) => {
    const providerClash = await getOverlappingAppointments(
      tx,
      { providerId: input.providerId },
      startDate,
      endDate,
    );
    if (providerClash.length > 0) {
      throw conflict("El horario acaba de ser tomado por otro turno");
    }
    if (machineId) {
      const machineClash = await getOverlappingAppointments(
        tx,
        { machineId },
        startDate,
        endDate,
      );
      if (machineClash.length > 0) {
        throw conflict("La máquina acaba de ser tomada por otro turno");
      }
    }

    const apptStatus = input.status ?? "scheduled";
    const reservationExpiresAt =
      apptStatus === "reserved"
        ? new Date(Date.now() + (input.expiryMinutes ?? 60) * 60_000)
        : null;

    const appointment = await insertAppointment(tx, {
      customerId: input.customerId,
      serviceProviderId: input.providerId,
      serviceId: input.serviceId,
      machineId,
      appointmentStart: startDate,
      appointmentEnd: endDate,
      durationMinutes,
      servicePrice,
      status: apptStatus,
      reservationExpiresAt,
      notes: input.notes ?? null,
    });

    // Las zonas elegidas, para el detalle del recibo y la trazabilidad de qué
    // se depiló. Sólo existe con el servicio ancla (validado arriba).
    if (esDepilacion) {
      await tx.insert(appointmentBodyZone).values(
        zonasParaGuardar.map((z) => ({
          appointmentId: appointment.id,
          bodyZoneId: z.bodyZoneId,
          minutos: z.minutos,
        })),
      );
    }

    // Descontar el servicio comprado, si el turno viene atado a una compra.
    //
    // Va DENTRO de la transacción y con su propia guarda: entre que la pantalla
    // preguntó qué había disponible y el momento de guardar, otra persona pudo
    // haber agendado ese mismo servicio comprado. Sin el chequeo, la segunda
    // pisaría a la primera y el pack quedaría con una sesión de más.
    if (input.customerPurchaseServiceId) {
      if (esDepilacion) {
        // No usa `tomarServicio`: esa guarda busca por `service_id`, y una
        // línea de depilación lo tiene en NULL (su identidad vive en
        // `depilation_combo_id`, ver `consumo.repo.ts`). Comparte con
        // `tomarServicio` la misma guarda atómica ante carreras
        // (`tomarFilaSiLibre`, privada de `consumo.repo.ts`) — sólo cambia de
        // dónde sale la lista de "libres" para el error temprano.
        await tomarLineaDeDepilacion(tx, input.customerPurchaseServiceId, {
          appointmentId: appointment.id,
          customerId: input.customerId,
          ahora: new Date(),
        });
      } else {
        await tomarServicio(tx, input.customerPurchaseServiceId, {
          appointmentId: appointment.id,
          customerId: input.customerId,
          serviceId: input.serviceId,
          ahora: new Date(),
        });
      }
    }

    if (input.deposit && arca) {
      await registerDeposit(tx, arca, {
        appointmentId: appointment.id,
        customerId: input.customerId,
        contactId: customer.contactId ?? null,
        customerName: customer.name ?? null,
        serviceId: input.serviceId,
        serviceName: ctx.service.name ?? null,
        servicePrice: Number(servicePrice ?? 0),
        deposit: input.deposit,
      });
    }

    return appointment;
  });
}

export async function listAppointmentsByDay(
  db: Db,
  date: string,
  filters: { providerId?: string; status?: string },
) {
  return listAppointmentsByRange(db, localDayRangeUtc(date), filters);
}

const VALID_STATUSES = ["reserved", "scheduled", "completed", "cancelled", "no_show"];

export async function updateAppointmentStatus(
  db: Db,
  id: string,
  changes: { status?: string; notes?: string },
) {
  const appt = await getAppointmentById(db, id);
  if (!appt) throw notFound("Appointment");

  const values: Record<string, unknown> = {};
  if (changes.notes !== undefined) values.notes = changes.notes;

  /** Seña a devolver como saldo a favor al cancelar (null = no hay nada que acreditar). */
  let dealToCancel: { id: string; amount: number; customerId: string } | null = null;

  /** Sólo la TRANSICIÓN descuenta insumos. Volver a mandar 'completed' sobre un
   *  turno ya completado no descuenta de nuevo. */
  const completando = changes.status === "completed" && appt.status !== "completed";

  if (changes.status) {
    if (!VALID_STATUSES.includes(changes.status)) throw badRequest("Estado inválido");
    if (appt.status === "completed" && changes.status !== "completed") {
      throw conflict("Un turno completado no puede cambiar de estado");
    }

    // La puerta de pago (Task 13) también aplica acá. `createAppointment`
    // sólo la evalúa al CREAR el turno, pero un turno de depilación puede
    // volverse turno real por varios caminos que no pasan por ahí:
    // "Confirmar reserva" (reserved → scheduled), "Realizado" apretado
    // directo sobre una reserva (reserved → completed, salteándose
    // scheduled) y "Restaurar" sobre un turno cancelado o ausente
    // (cancelled/no_show → scheduled). Son todos la misma puerta de entrada
    // que `createAppointment` — si sólo se cierra una, la otra la reemplaza
    // sin que nadie note que hay varias.
    //
    // **La condición mira el estado DESTINO, no el de partida** (ronda 3).
    // La versión vieja colgaba de `appt.status === "reserved"`, así que
    // bastaba con que la reserva pasara antes por `cancelled` —a mano o por
    // el `pg_cron` que expira reservas— o por `no_show` para que "Restaurar"
    // la agendara sin cobrar nada. La pregunta correcta no es de dónde
    // viene el turno sino si QUEDA comprometiendo la agenda.
    //
    // Cancelar y "Ausente" NO pasan por acá a propósito: bloquear una
    // cancelación por falta de pago le sacaría a Laura la única herramienta
    // para liberar un turno que no se va a cobrar.
    //
    // `scheduled → completed` no se re-evalúa: ese turno YA pasó la puerta
    // (al crearse, o al confirmarse desde acá mismo) — repetir la cuenta acá
    // no cambia nada salvo el costo de la consulta.
    const quedaComprometido =
      changes.status === "scheduled" || changes.status === "completed";
    const yaEstabaComprometido = appt.status === "scheduled" || appt.status === "completed";
    const dejaLaReserva = quedaComprometido && !yaEstabaComprometido;
    if (dejaLaReserva) {
      const ancla = await anclaDeDepilacionOpcional(db);
      if (ancla != null && appt.serviceId === ancla) {
        // `puertaDeLaReserva` y no `datosParaAgendar`: a esta altura la línea
        // ya está tomada por ESTE turno, así que `lineasDeDepilacionLibres`
        // ya no la ve libre — `datosParaAgendar` la busca ahí y tira
        // "Servicio de depilación not found" si se la llama con una línea ya
        // tomada. `puertaDeLaReserva` lee la línea directo por
        // `appointmentId` y comparte la MISMA cuenta (`puertaDeLaLinea`
        // dentro de `turno-de-depilacion.repo.ts`) — no hay una segunda
        // fórmula de la puerta, sólo una forma distinta de encontrar la
        // línea. `null` = sin línea comprada asociada (no debería pasar; si
        // pasa, no es esta guarda la que decide).
        const puerta = await puertaDeLaReserva(db, id);
        if (puerta && !puerta.puedeAgendar) {
          throw badRequest(`${puerta.motivo} (falta $${puerta.faltaCobrar})`);
        }
      }
    }

    values.status = changes.status;

    // Al confirmar una reserva → limpiar la fecha de expiración
    if (changes.status === "scheduled" && appt.status === "reserved") {
      values.reservationExpiresAt = null;
    }

    // Al completar se congela el snapshot de pago a la proveedora
    if (completando) {
      const snapshot = await computeProviderEarning(db, appt);
      Object.assign(values, snapshot);
    }


    // Al cancelar: si había una seña paga, se cancela el deal y se acredita
    // el saldo al cliente (no se pierde la plata — reglas_negocio §6.2).
    //
    // Solo se acredita si se cancela ANTES del horario del turno: avisar con
    // tiempo devuelve la seña, no presentarse la pierde. Cancelar un turno que
    // ya pasó es equivalente a un "Ausente" (que tampoco acredita), y sin este
    // corte se regalaba saldo con solo ir cancelando turnos viejos.
    //
    // Solo se RESUELVE acá; los tres writes (cancelar deal, acreditar saldo y
    // marcar el turno cancelado) se hacen abajo en una única transacción.
    if (changes.status === "cancelled" && appt.status !== "cancelled") {
      const beforeStart = !appt.appointmentStart || appt.appointmentStart > new Date();
      const deal = await getDealByAppointmentId(db, id);
      if (beforeStart && deal?.seniaPaid && deal.seniaAmount && appt.customerId) {
        dealToCancel = {
          id: deal.id,
          amount: Number(deal.seniaAmount),
          customerId: appt.customerId,
        };
      }
    }
  }

  // Al completar, el turno, el descuento de insumos y el consumo de la sesión
  // pasan JUNTOS o no pasa ninguno: si el turno quedara completado y el
  // descuento fallara, el stock mentiría para siempre y nadie se enteraría, y
  // si fallara el consumo la clienta se quedaría con una sesión que ya usó.
  // `consumo` viaja al front para avisar si algún insumo quedó en negativo —
  // no frena nada.
  //
  // El AUSENTE no escribe nada acá, y es a propósito: `estadoDeSesion()` ya lo
  // deriva como "perdida" mirando el estado del turno (reglas §3.8). Así, si
  // Laura marcó ausente por error y lo corrige, la sesión vuelve sola a estar
  // disponible; con una columna escrita habría que acordarse de deshacerla.
  if (completando) {
    return db.transaction(async (tx) => {
      const updated = await updateAppointment(tx, id, values);
      const consumo = await consumirInsumos(tx, id, appt.serviceId);
      await consumirServicioDelTurno(tx, id, new Date());
      return { ...updated, consumo };
    });
  }

  if (!dealToCancel) return updateAppointment(db, id, values);

  // Atómico: o se cancela el deal + se acredita el saldo + se cancela el turno,
  // o no pasa nada. Si esto se partiera en dos transacciones podría quedar el
  // saldo acreditado con el turno todavía activo (o al revés).
  const pending = dealToCancel;
  return db.transaction(async (tx) => {
    const cancelled = await cancelDeal(tx, pending.id, { cancelReason: "Turno cancelado" });
    if (cancelled) {
      await creditCustomer(tx, pending.customerId, pending.amount, {
        reason: "appointment_cancelled",
        appointmentId: id,
        notes: "Seña de un turno cancelado antes de su horario",
      });
    }
    return updateAppointment(tx, id, values);
  });
}

/**
 * Mueve un turno y deja constancia.
 *
 * `quien` trae el usuario del JWT y el motivo opcional que escribió quien lo
 * movió. Es opcional para no romper a nadie que llame a esto sin contexto de
 * request, pero el endpoint siempre lo manda.
 */
export async function rescheduleAppointment(
  db: Db,
  id: string,
  newStart: string,
  quien: QuienYPorQue = {},
) {
  const startDate = new Date(newStart);
  if (Number.isNaN(startDate.getTime())) throw badRequest("Fecha de inicio inválida");

  const appt = await getAppointmentById(db, id);
  if (!appt) throw notFound("Appointment");
  if (appt.status === "completed") throw conflict("Un turno completado no puede reagendarse");
  if (!appt.serviceId || !appt.serviceProviderId) throw badRequest("Turno sin servicio o proveedora");

  const localDate = utcToLocalDateString(startDate);
  // El quinto argumento saca a este mismo turno del cálculo de ocupación: si no,
  // se bloquea a sí mismo y no se lo puede correr media hora.
  const ctx = await loadAvailabilityContext(db, appt.serviceId, localDate, appt.serviceProviderId, id);
  if (!ctx.open) throw conflict("El local está cerrado ese día");
  if (ctx.providers.length === 0) throw conflict("La proveedora no está disponible ese día");

  // Reagendar mueve el CUÁNDO, no el QUÉ: para depilación, `ctx.durationMinutes`
  // sale de `service.estimated_duration_minutes` del ancla, que es un valor de
  // relleno (30, migración 1.56.0) sin relación con las zonas elegidas. La
  // duración real del turno es la que ya tiene guardada — la que salió de
  // `minutosElegidos` al crearlo — y esa no cambia porque cambie la hora. Un
  // sólo `durationMinutes` de acá en adelante: el intervalo pedido, el
  // `endDate`, la franja del historial y el UPDATE final tienen que ver el
  // mismo número, o se valida disponibilidad contra una duración y se guarda
  // otra.
  const ancla = await anclaDeDepilacionOpcional(db);
  const esDepilacion = ancla != null && appt.serviceId === ancla;
  const durationMinutes = esDepilacion ? appt.durationMinutes ?? ctx.durationMinutes : ctx.durationMinutes;

  const startMin = utcToLocalMinutes(startDate);
  const requested: Interval = { start: startMin, end: startMin + durationMinutes };
  const endDate = new Date(startDate.getTime() + durationMinutes * 60_000);

  const freeWindows = ctx.freeWindowsByProvider.get(appt.serviceProviderId) ?? [];
  const fits = freeWindows.some((w) => requested.start >= w.start && requested.end <= w.end);
  if (!fits) throw conflict("La proveedora no tiene ese horario disponible");

  return db.transaction(async (tx) => {
    const clashes = await getOverlappingAppointments(
      tx,
      { providerId: appt.serviceProviderId! },
      startDate,
      endDate,
    );
    const realClashes = clashes.filter((c) => c.id !== id);
    if (realClashes.length > 0) throw conflict("El horario acaba de ser tomado por otro turno");

    // Antes del UPDATE, porque después la fecha vieja ya no existe en ningún
    // lado. Va en la misma transacción: o se mueve y queda registrado, o no
    // pasa ninguna de las dos cosas.
    const franja = { start: startDate, end: endDate, durationMinutes };
    if (huboMovimiento(appt, franja)) {
      await recordReschedule(tx, filaDeReagendado(appt, franja, quien));
    }

    // Reagendar mueve el CUÁNDO, no la categoría del turno (ronda 3,
    // Critical 1). Para cualquier servicio, reagendar una reserva la
    // confirma —es el comportamiento de siempre y ahí no hay nada que
    // cobrar—, pero una reserva de DEPILACIÓN que se asciende a `scheduled`
    // se saltea la puerta de pago: quedaba agendada sin un peso cobrado y
    // con `reservation_expires_at` en NULL, así que el `pg_cron` que expira
    // reservas ya no la alcanzaba nunca y la sesión comprada quedaba tomada
    // para siempre. Y no es un rodeo raro: el modal de "Reserva expirada"
    // ofrece "Reagendar" como acción principal.
    //
    // Mover una reserva de horario es legítimo y tiene que seguir andando,
    // así que sigue siendo una reserva, con su mismo vencimiento. Para
    // convertirla en turno real está "Confirmar reserva", que sí pasa por la
    // puerta (`updateAppointmentStatus`).
    const sigueSiendoReserva = esDepilacion && appt.status === "reserved";

    return updateAppointment(tx, id, {
      appointmentStart:      startDate,
      appointmentEnd:        endDate,
      durationMinutes,
      status:                sigueSiendoReserva ? "reserved" : "scheduled",
      reservationExpiresAt:  sigueSiendoReserva ? appt.reservationExpiresAt : null,
    });
  });
}

export async function computeProviderEarning(
  db: Db,
  appt: NonNullable<Awaited<ReturnType<typeof getAppointmentById>>>,
) {
  if (!appt.serviceProviderId || !appt.serviceId) return {};

  // ¿Este turno sale de una compra hecha con promo, y esa promo le fija un
  // pago a esta proveedora por este servicio? (1.53.0)
  //
  // Se entra por `appointment_id` y no por los campos del turno: así no
  // depende de qué columnas devuelva cada lectura de appointments.
  const [pago] = await db.execute<{ provider_payment: string }>(sql`
    select ps.provider_payment
      from customer_purchase_service cps
      join customer_purchase cp on cp.id = cps.customer_purchase_id
      join promotion_service ps on ps.promotion_id = cp.promotion_id
     where cps.appointment_id = ${appt.id}
       and ps.service_id = ${appt.serviceId}
       and ps.service_provider_id = ${appt.serviceProviderId}
     limit 1
  `);

  const agreement = await getActiveAgreement(db, appt.serviceProviderId, appt.serviceId);
  const svc =
    agreement?.paymentType === "percentage" ? await getServiceById(db, appt.serviceId) : null;

  return gananciaDelTurno(
    pago ? Number(pago.provider_payment) : null,
    agreement?.paymentType && agreement.rate != null
      ? { paymentType: agreement.paymentType, rate: Number(agreement.rate) }
      : null,
    appt.durationMinutes ?? 0,
    Number(svc?.unitPriceCash ?? 0),
  );
}
