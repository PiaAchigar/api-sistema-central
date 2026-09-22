import { and, count, desc, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  appointments,
  cashRegister,
  customerCreditMovements,
  customerPurchase,
  customerPurchaseService,
  invoices,
  lineItems,
  payments,
  service,
  depilationCombo,
  training,
  promotionTarget,
} from "../db/schema";
import {
  estadoDeSesion,
  nombreDeCabecera,
  nombreDeLaLinea,
  resumenDeCompra,
  tieneTurno,
  type EstadoSesion,
} from "../lib/compras";
import { razonesParaNoBorrarCompra, type ImpactoDeBorrado } from "../lib/compra-borrado";
import { saldoAAcreditar, type ServicioParaSaldo } from "../lib/saldo-de-cancelacion";
import { planDePagoConSaldo } from "../lib/pago-con-saldo";
import { vencimientoPara } from "../lib/vencimiento-de-saldo";
import { comprobantesDeDevolucion, repartirDevolucion } from "../lib/devolucion-declarada";
import { getInvoiceById, updateInvoice } from "./invoices.repo";
import { vencimientoHeredado } from "../lib/herencia-de-vencimiento";
import {
  montoADevolver,
  razonesParaNoDevolver,
  type CompraParaDevolver,
} from "../lib/devolucion";
import { creditCustomer, debitCustomerCredit, getCustomerById } from "./customers.repo";
import { lineasParaVender } from "./combos.repo";
import {
  filasDeServicioComprado,
  ordenDeServiciosComprados,
  type LineaDeCombo,
} from "../lib/servicios-comprados";
import { lineasDelPaquete, type ParteDelPaquete } from "../lib/desglose-de-paquete";
import { repartirPrecioDelPaquete } from "../lib/reparto-de-paquete";

const compraFields = {
  id: customerPurchase.id,
  customerId: customerPurchase.customerId,
  comboId: customerPurchase.comboId,
  serviceId: customerPurchase.serviceId,
  depilationComboId: customerPurchase.depilationComboId,
  trainingId: customerPurchase.trainingId,
  description: customerPurchase.description,
  sessionsTotal: customerPurchase.sessionsTotal,
  baseAmount: customerPurchase.baseAmount,
  discountedAmount: customerPurchase.discountedAmount,
  promotionId: customerPurchase.promotionId,
  promotionName: customerPurchase.promotionName,
  finalAmount: customerPurchase.finalAmount,
  purchasedAt: customerPurchase.purchasedAt,
  expiresAt: customerPurchase.expiresAt,
  cancelledAt: customerPurchase.cancelledAt,
  notes: customerPurchase.notes,
  esPaqueteDePromo: customerPurchase.esPaqueteDePromo,
};

export type CompraInput = {
  customerId: string;
  /** Exactamente uno. Lo valida el CHECK de la base, y esto lo valida antes. */
  comboId?: string | null;
  serviceId?: string | null;
  depilationComboId?: string | null;
  trainingId?: string | null;
  description: string;
  sessionsTotal: number;
  baseAmount: number;
  discountedAmount: number;
  finalAmount: number;
  promotionId?: string | null;
  /** El nombre de la promo, congelado al vender (1.53.0). */
  promotionName?: string | null;
  expiresAt?: Date | null;
  notes?: string | null;
  /**
   * Cuánto del saldo a favor de la clienta se aplica a esta compra. `null` o
   * ausente = no usar saldo. Se topea contra lo que hay y contra el precio.
   */
  usarSaldo?: number | null;
  /**
   * Esta compra es un paquete de promo (1.55.0): no tiene ningún origen
   * suelto, y sus líneas salen de los destinos de la promo. Exige
   * `promotionId`.
   */
  esPaquete?: boolean | null;
};

const dec = (n: number) => String(n);

/**
 * Vende: crea la compra y sus N servicios comprados, todavía sin turno, en
 * UNA transacción.
 *
 * Los servicios comprados nacen con la compra y no cuando se agendan. Si
 * nacieran al agendar, "cuántos te quedan" habría que calcularlo restando, y
 * una compra de 6 servicios comprados sin ninguno agendado se vería igual
 * que una de 0. Un servicio comprado recién pasa a ser una *sesión* cuando
 * se le engancha un turno (spec 2026-09-11 §2).
 */
export async function createCompra(db: Db, input: CompraInput) {
  if (input.esPaquete) {
    const sueltos = [input.comboId, input.serviceId, input.depilationComboId, input.trainingId]
      .filter(Boolean);
    if (sueltos.length > 0) {
      throw new Error("Un paquete de promo no lleva ningún origen suelto: lo que lleva sale de la promo");
    }
    if (!input.promotionId) {
      throw new Error("Un paquete de promo necesita la promo: es de donde salen las cosas que lleva");
    }
  } else {
    const origenes = [input.comboId, input.serviceId, input.depilationComboId, input.trainingId]
      .filter(Boolean);
    if (origenes.length !== 1) {
      throw new Error(
        "Una compra tiene exactamente un origen: combo, servicio, combo de depilación o capacitación",
      );
    }
  }
  if (input.sessionsTotal < 1) throw new Error("La compra necesita al menos una repetición");

  return db.transaction(async (tx) => {
    const filas = await tx
      .insert(customerPurchase)
      .values({
        customerId: input.customerId,
        comboId: input.comboId ?? null,
        serviceId: input.serviceId ?? null,
        depilationComboId: input.depilationComboId ?? null,
        trainingId: input.trainingId ?? null,
        description: input.description,
        sessionsTotal: input.sessionsTotal,
        baseAmount: dec(input.baseAmount),
        discountedAmount: dec(input.discountedAmount),
        promotionId: input.promotionId ?? null,
        promotionName: input.promotionName ?? null,
        finalAmount: dec(input.finalAmount),
        purchasedAt: new Date(),
        expiresAt: input.expiresAt ?? null,
        notes: input.notes ?? null,
        esPaqueteDePromo: input.esPaquete === true,
      })
      .returning(compraFields);

    const compra = filas[0]!;

    // Qué hay que agendar. Un paquete sale de los destinos de la promo; el
    // resto es como hasta la 1.55.0.
    const lineas: LineaDeCombo[] = input.esPaquete
      ? await lineasDeUnPaquete(tx, input.promotionId!, input.finalAmount)
      : input.comboId
        ? await lineasParaVender(tx, input.comboId)
        : input.serviceId
          ? // Sin precio a propósito: todas las filas son el mismo servicio,
            // así que el reparto en partes iguales ya da lo correcto.
            [{ serviceId: input.serviceId, sessionsIncluded: 1, price: null }]
          : [];

    // Un paquete no tiene "vueltas": `lineasDeUnPaquete` ya expandió cantidad
    // y sessionsIncluded en filas separadas (una por cosa a agendar), así que
    // acá cada línea es directamente una fila, con `orden` = su posición.
    //
    // No se puede reusar `filasDeServicioComprado` para esto: reinicia
    // `orden` en 1 por cada línea, y dos líneas de un paquete pueden compartir
    // el mismo `service_id` (p. ej. "3 limpiezas de cutis" son 3 líneas con
    // el mismo servicio) — las tres caerían con `orden: 1` y chocarían contra
    // `ux_cpsv_fila` (customer_purchase_id, repeticion, service_id, orden).
    // Un `orden` por posición es además más correcto para un paquete: no hay
    // "vuelta" que numerar, sólo el orden en que Laura armó el paquete.
    const filasDeCompra = input.esPaquete
      ? lineas.map((l, i) => ({
          serviceId: l.serviceId,
          depilationComboId: l.depilationComboId ?? null,
          trainingId: l.trainingId ?? null,
          repeticion: 1,
          orden: i + 1,
          price: l.price,
        }))
      : filasDeServicioComprado(input.sessionsTotal, lineas);

    await tx.insert(customerPurchaseService).values(
      filasDeCompra.map((f) => ({
        customerPurchaseId: compra.id,
        serviceId: f.serviceId,
        depilationComboId: f.depilationComboId,
        trainingId: f.trainingId,
        repeticion: f.repeticion,
        orden: f.orden,
        price: f.price == null ? null : String(f.price),
      })),
    );

    const conSaldo = await aplicarSaldoAFavor(tx, compra.id, input);
    return { ...compra, pagadoConSaldo: conSaldo };
  });
}

/**
 * Aplica el saldo a favor de la clienta a una compra recién creada.
 *
 * El saldo aplicado se registra como un `payments` CONFIRMADO. Sin eso la
 * compra diría "Debe $166.000" con la plata ya puesta: el saldo es la única
 * definición del saldo pendiente (`final_amount − Σ pagos confirmados`), así
 * que lo que no está ahí no existe.
 *
 * ⚠️ **`isDeclared: false`.** El saldo NO es ingreso nuevo: entró y se declaró
 * cuando se cobró la compra original. Contarlo otra vez inflaría la caja del
 * día con plata que nunca volvió a entrar. Mismo criterio que las señas
 * pagadas con saldo (`deposits.service.ts`).
 *
 * Devuelve cuánto se aplicó, 0 si nada.
 */
async function aplicarSaldoAFavor(tx: Db, compraId: string, input: CompraInput): Promise<number> {
  if (!input.usarSaldo || input.usarSaldo <= 0) return 0;

  const cliente = await getCustomerById(tx, input.customerId);
  if (!cliente) throw new Error("No encontramos la cuenta de esta clienta");

  const plan = planDePagoConSaldo({
    aPagar: input.finalAmount,
    saldoDisponible: Number(cliente.creditBalance ?? 0),
    usar: input.usarSaldo,
  });
  if (plan.conSaldo <= 0) return 0;

  const ahora = new Date();
  const [pago] = await tx
    .insert(payments)
    .values({
      customerId: input.customerId,
      customerPurchaseId: compraId,
      amount: dec(plan.conSaldo),
      paymentMethod: "credit",
      status: "confirmed",
      paymentDate: ahora,
      isDeclared: false,
      notes: `Pagado con saldo a favor — ${input.description}`,
      confirmedAt: ahora,
    })
    .returning({ id: payments.id });

  // Si no alcanza acá, reventa la transacción entera y la compra no se crea.
  // Mejor eso que una venta con un pago que el saldo nunca respaldó.
  const ok = await debitCustomerCredit(tx, input.customerId, plan.conSaldo, {
    reason: "purchase_paid_with_credit",
    paymentId: pago?.id ?? null,
    customerPurchaseId: compraId,
    notes: `Compra de "${input.description}"`,
  });
  if (!ok) throw new Error("El saldo a favor de la clienta no alcanza para esta compra");

  return plan.conSaldo;
}

/**
 * Las líneas de un paquete, ya con su parte del precio.
 *
 * **Se desglosa AL VENDER, y queda congelado.** Si mañana Laura le saca una
 * cosa a la promo o le cambia el precio, la compra ya vendida no se mueve. Es
 * el mismo criterio que el resto del sistema: la compra no depende de que el
 * catálogo siga igual.
 */
async function lineasDeUnPaquete(
  tx: Db,
  promotionId: string,
  precioDelPaquete: number,
): Promise<LineaDeCombo[]> {
  const destinos = await tx
    .select({
      serviceId: promotionTarget.serviceId,
      comboId: promotionTarget.comboId,
      depilationComboId: promotionTarget.depilationComboId,
      cantidad: promotionTarget.cantidad,
    })
    .from(promotionTarget)
    .where(eq(promotionTarget.promotionId, promotionId));

  if (destinos.length === 0) {
    throw new Error("Esta promo no lleva nada adentro: no hay paquete que vender");
  }

  const partes: ParteDelPaquete[] = [];
  for (const d of destinos) {
    const cantidad = d.cantidad ?? 1;

    if (d.comboId) {
      const lineas = await lineasParaVender(tx, d.comboId);
      const precio = lineas.reduce((a, l) => a + (l.price ?? 0) * Math.max(1, l.sessionsIncluded), 0);
      partes.push({ tipo: "combo", id: d.comboId, cantidad, precioDeLista: precio, lineas });
      continue;
    }

    if (d.serviceId) {
      const [s] = await tx
        .select({ precio: service.unitPriceList })
        .from(service)
        .where(eq(service.id, d.serviceId))
        .limit(1);
      const precio = Number(s?.precio ?? 0);
      partes.push({
        tipo: "servicio", id: d.serviceId, cantidad, precioDeLista: precio,
        lineas: [{ serviceId: d.serviceId, depilationComboId: null, trainingId: null, sessionsIncluded: 1, price: precio }],
      });
      continue;
    }

    if (d.depilationComboId) {
      const [p] = await tx
        .select({ precio: depilationCombo.fixedPrice, nombre: depilationCombo.name })
        .from(depilationCombo)
        .where(eq(depilationCombo.id, d.depilationComboId))
        .limit(1);
      // Sin precio no se puede repartir nada, y adivinar sería peor: la
      // clienta cobraría cualquier cosa al cancelar (spec §5).
      if (p?.precio == null) {
        throw new Error(
          `"${p?.nombre ?? "Un pack de depilación"}" del paquete no tiene precio cargado: no se puede vender`,
        );
      }
      const precio = Number(p.precio);
      partes.push({
        tipo: "depilacion", id: d.depilationComboId, cantidad, precioDeLista: precio,
        lineas: [{ serviceId: null, depilationComboId: d.depilationComboId, trainingId: null, sessionsIncluded: 1, price: precio }],
      });
    }
  }

  const lineas = lineasDelPaquete(partes);
  // El reparto se hace sobre las líneas YA desglosadas, no sobre las partes:
  // un combo de 2 servicios aporta 2 filas, y cada una necesita su precio.
  const montos = repartirPrecioDelPaquete(
    precioDelPaquete,
    lineas.map((l) => l.price ?? 0),
  );
  return lineas.map((l, i) => ({ ...l, price: montos[i]! }));
}

export type ServicioLeido = {
  id: string;
  serviceId: string | null;
  serviceName: string | null;
  repeticion: number | null;
  orden: number | null;
  appointmentId: string | null;
  appointmentStart: Date | null;
  consumedAt: Date | null;
  estado: EstadoSesion;
};

/**
 * Las compras de una clienta, con sus servicios comprados y sus vueltas.
 *
 * Trae las tres consultas de una y arma todo en memoria: hacerlo por compra
 * sería N+1 sobre la ficha de la clienta, que es la pantalla que más se abre.
 */
export async function listComprasDeCliente(db: Db, customerId: string, ahora = new Date()) {
  const compras = await db
    .select({ ...compraFields, promotionName: customerPurchase.promotionName })
    .from(customerPurchase)
    .where(eq(customerPurchase.customerId, customerId))
    .orderBy(desc(customerPurchase.purchasedAt));

  if (compras.length === 0) return [];
  const ids = compras.map((c) => c.id);

  const [sesiones, pagos, devoluciones] = await Promise.all([
    db
      .select({
        id: customerPurchaseService.id,
        customerPurchaseId: customerPurchaseService.customerPurchaseId,
        serviceId: customerPurchaseService.serviceId,
        serviceName: service.name,
        repeticion: customerPurchaseService.repeticion,
        orden: customerPurchaseService.orden,
        appointmentId: customerPurchaseService.appointmentId,
        consumedAt: customerPurchaseService.consumedAt,
        appointmentStatus: appointments.status,
        appointmentStart: appointments.appointmentStart,
      })
      .from(customerPurchaseService)
      .leftJoin(service, eq(service.id, customerPurchaseService.serviceId))
      .leftJoin(appointments, eq(appointments.id, customerPurchaseService.appointmentId))
      .where(inArray(customerPurchaseService.customerPurchaseId, ids)),
    db
      .select({
        customerPurchaseId: payments.customerPurchaseId,
        amount: payments.amount,
        invoiceId: payments.invoiceId,
      })
      .from(payments)
      .where(
        and(inArray(payments.customerPurchaseId, ids), eq(payments.status, "confirmed")),
      ),
    // Las devoluciones ya hechas. El movimiento es NEGATIVO (sale del saldo),
    // así que se le da vuelta el signo para mostrarlo.
    db
      .select({
        customerPurchaseId: customerCreditMovements.customerPurchaseId,
        amount: customerCreditMovements.amount,
      })
      .from(customerCreditMovements)
      .where(
        and(
          inArray(customerCreditMovements.customerPurchaseId, ids),
          eq(customerCreditMovements.reason, "refunded"),
        ),
      ),
  ]);

  // Cómo se llama una línea que NO es un servicio.
  //
  // `customer_purchase_service.service_id` va en NULL para depilación y
  // capacitaciones: esas compras no se desglosan en servicios. Quién es la
  // línea lo sabe la CABECERA de la compra, así que el nombre sale de ahí.
  // Sin esto la ficha de la clienta dibuja un guión en cada renglón —una
  // compra de 3 sesiones de "Cuerpo Full" se ve como "—", "—", "—"— y no hay
  // forma de saber qué compró.
  //
  // Funciona porque hoy una compra tiene UN solo origen. Cuando la promo se
  // venda como paquete, la línea va a traer su propia identidad y esto queda
  // como respaldo para las compras viejas.
  const packIds = [...new Set(compras.map((c) => c.depilationComboId).filter((v): v is string => v != null))];
  const capIds = [...new Set(compras.map((c) => c.trainingId).filter((v): v is string => v != null))];

  const [packs, capacitaciones] = await Promise.all([
    packIds.length > 0
      ? db
          .select({ id: depilationCombo.id, name: depilationCombo.name })
          .from(depilationCombo)
          .where(inArray(depilationCombo.id, packIds))
      : [],
    capIds.length > 0
      ? db
          .select({ id: training.id, name: training.name })
          .from(training)
          .where(inArray(training.id, capIds))
      : [],
  ]);
  // `training.name` es nullable en el esquema, así que las sin nombre se
  // descartan: dejar una entrada en null haría que el respaldo "funcione"
  // devolviendo nada, que es el bug que esto viene a arreglar.
  const nombrePorId = new Map<string, string>(
    [...packs, ...capacitaciones]
      .filter((f): f is { id: string; name: string } => f.name != null)
      .map((f) => [f.id, f.name]),
  );

  // Notas de crédito todavía en borrador. La emite Laura desde el facturador,
  // pero el CRM tiene que poder decir que falta: si la clienta llama
  // preguntando por su devolución, quien atiende no debería abrir otra app.
  const facturasDeCompras = pagos
    .map((p) => p.invoiceId)
    .filter((v): v is string => v != null);
  const notasPendientes =
    facturasDeCompras.length > 0
      ? await db
          .select({ creditNoteOf: invoices.creditNoteOf })
          .from(invoices)
          .where(
            and(
              inArray(invoices.creditNoteOf, facturasDeCompras),
              eq(invoices.status, "draft"),
            ),
          )
      : [];
  const facturasConNotaPendiente = new Set(
    notasPendientes.map((n) => n.creditNoteOf).filter((v): v is string => v != null),
  );

  return compras.map((c) => {
    const mias = sesiones.filter((s) => s.customerPurchaseId === c.id);
    // El nombre de respaldo de ESTA compra, para sus líneas sin servicio.
    const respaldo = nombreDeCabecera(c, nombrePorId);
    const vigencia = { expiresAt: c.expiresAt, cancelledAt: c.cancelledAt };
    const resumen = resumenDeCompra(
      { finalAmount: Number(c.finalAmount), ...vigencia },
      mias,
      pagos.filter((p) => p.customerPurchaseId === c.id).map((p) => Number(p.amount)),
      ahora,
    );
    const misDevoluciones = devoluciones.filter((d) => d.customerPurchaseId === c.id);
    const devuelto = misDevoluciones.reduce((a, d) => a + Math.abs(Number(d.amount)), 0);
    const notaDeCreditoPendiente = pagos.some(
      (p) =>
        p.customerPurchaseId === c.id &&
        p.invoiceId != null &&
        facturasConNotaPendiente.has(p.invoiceId),
    );

    return {
      ...c,
      baseAmount: Number(c.baseAmount),
      discountedAmount: Number(c.discountedAmount),
      finalAmount: Number(c.finalAmount),
      /** La devolución exigía nota de crédito y todavía está en borrador. */
      notaDeCreditoPendiente,
      // La pantalla necesita saberlo para no ofrecer devolver dos veces y para
      // mostrar que esta compra ya se cerró con plata en mano.
      devuelta: misDevoluciones.length > 0,
      devuelto,
      ...resumen,
      servicios: mias
        // Vuelta por vuelta y, dentro de cada vuelta, por `orden` con
        // desempate estable: es como la ficha los agrupa, así no hay que
        // reordenar en el navegador. El desempate no sobra — la consulta no
        // lleva ORDER BY y sin él los dos servicios de un combo se daban
        // vuelta solos; ver `ordenDeServiciosComprados`.
        .sort(ordenDeServiciosComprados)
        .map((s): ServicioLeido => {
          const estado = estadoDeSesion(s, vigencia, ahora);
          // Un turno cancelado no se publica: la fila volvió a "a agendar" y
          // esa fecha ya no es su turno. Ver `tieneTurno`.
          const conTurno = tieneTurno(estado);
          return {
            id: s.id,
            serviceId: s.serviceId,
            serviceName: nombreDeLaLinea(s.serviceName, respaldo),
            repeticion: s.repeticion,
            orden: s.orden,
            appointmentId: conTurno ? s.appointmentId : null,
            appointmentStart: conTurno ? s.appointmentStart : null,
            consumedAt: s.consumedAt,
            estado,
          };
        }),
    };
  });
}

/**
 * Cancela una compra y le deja a la clienta lo que pagó de más como SALDO A
 * FAVOR. No borra: puede tener pagos y facturas colgando, y una venta cancelada
 * sigue siendo parte de la historia de la clienta.
 *
 * Las sesiones sin usar pasan solas a *vencida* — se deriva de `cancelledAt`.
 *
 * **Por qué acredita en vez de devolver:** lo que Laura quiere primero es
 * ofrecerle a la clienta usar esa plata en otro tratamiento, no sacarla de la
 * caja (decisión de Pia, 2026-09-09). La devolución existe, pero es el último
 * recurso y es un botón aparte.
 *
 * Todo en UNA transacción: cancelar sin acreditar dejaría a la clienta sin la
 * plata y sin el pack.
 */
export async function cancelCompra(db: Db, id: string, motivo?: string | null) {
  return db.transaction(async (tx) => {
    const filas = await tx
      .update(customerPurchase)
      .set({
        cancelledAt: new Date(),
        notes: motivo ?? undefined,
        updatedAt: new Date(),
      })
      // Sólo si no estaba cancelada: cancelar dos veces pisaría la fecha de la
      // primera, que es la que dice cuándo dejó de valer, y acreditaría la
      // plata dos veces.
      .where(and(eq(customerPurchase.id, id), isNull(customerPurchase.cancelledAt)))
      .returning(compraFields);

    const compra = filas[0];
    if (!compra) return null;

    const acreditado = await acreditarSobranteDeCompra(tx, compra);
    return { ...compra, saldoAcreditado: acreditado };
  });
}

/**
 * Los servicios comprados de una compra, con lo que valen y si ya se usaron.
 *
 * Es lo que necesita la cuenta de la cancelación, y lo necesitan las DOS
 * puertas por las que sale plata —el saldo a favor y la devolución en
 * efectivo—, así que sale de un solo lugar.
 *
 * **Usado** es consumido O perdido por ausente. El ausente cuenta como usado:
 * el turno ocupó una hora que nadie más pudo usar (regla de Laura,
 * 2026-09-09). Agendado no cuenta: todavía no pasó nada.
 *
 * **`price` puede venir en NULL** —depilación, capacitaciones, y cualquier
 * compra anterior a la 1.52.0 que no se haya podido rellenar— y ahí
 * `proporcionUsada` reparte en partes iguales, que para esas compras es lo
 * correcto.
 */
async function serviciosParaSaldo(tx: Db, compraId: string): Promise<ServicioParaSaldo[]> {
  const filas = await tx
    .select({
      price: customerPurchaseService.price,
      consumedAt: customerPurchaseService.consumedAt,
      estadoDelTurno: appointments.status,
    })
    .from(customerPurchaseService)
    .leftJoin(appointments, eq(appointments.id, customerPurchaseService.appointmentId))
    .where(eq(customerPurchaseService.customerPurchaseId, compraId));

  return filas.map((f) => ({
    price: f.price == null ? null : Number(f.price),
    usado: f.consumedAt != null || f.estadoDelTurno === "no_show",
  }));
}

/**
 * Le acredita a la clienta lo que pagó por sesiones que no llegó a usar.
 *
 * Devuelve cuánto se acreditó (0 si no había nada), para que la pantalla pueda
 * decir "le quedaron $110.667 a favor" en vez de dejarlo mudo.
 */
async function acreditarSobranteDeCompra(
  tx: Db,
  compra: { id: string; customerId: string | null; finalAmount: string | null },
): Promise<number> {
  if (!compra.customerId) return 0;

  const [cobrado] = await tx
    .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)` })
    .from(payments)
    .where(
      and(eq(payments.customerPurchaseId, compra.id), eq(payments.status, "confirmed")),
    );

  // Dos números de la MISMA tabla, en una sola consulta:
  //
  // - `usadas` = consumidas + PERDIDAS. Una clienta que no vino perdió el
  //   servicio y su plata (regla de Laura, 2026-09-09): devolverla como saldo
  //   a favor sería premiar el ausente, que es justo lo que la regla evita.
  // - `todos` = el denominador del prorrateo. Tiene que salir de acá y NO de
  //   `sessions_total`: desde V3b `sessions_total` son las REPETICIONES de la
  //   compra y las filas son una por servicio y por repetición. Un combo de 2
  //   servicios vendido suelto tiene `sessions_total` 1 y dos filas; contar
  //   por repeticiones le acreditaba a la clienta $0 donde le tocaban $106.600
  //   (revisión final de V3b, 2026-09-14).
  const monto = saldoAAcreditar({
    pagado: Number(cobrado?.total ?? 0),
    finalAmount: Number(compra.finalAmount ?? 0),
    servicios: await serviciosParaSaldo(tx, compra.id),
  });
  if (monto <= 0) return 0;

  const ahora = new Date();

  // Si la compra se pagó con saldo a favor, la plata vuelve con la fecha que
  // YA TENÍA. Cancelar no estira plazos (regla de Pia, 2026-09-10): con tres
  // meses nuevos, comprar algo y arrepentirse limpiaba el vencimiento —a Sofía
  // le convirtió $80.000 vencidos en plata fresca sin que nadie lo buscara—.
  const movimientos = await tx
    .select({
      amount: customerCreditMovements.amount,
      createdAt: customerCreditMovements.createdAt,
      expiresAt: customerCreditMovements.expiresAt,
      customerPurchaseId: customerCreditMovements.customerPurchaseId,
    })
    .from(customerCreditMovements)
    .where(eq(customerCreditMovements.customerId, compra.customerId));

  const heredado = vencimientoHeredado(
    movimientos.map((m) => ({
      amount: Number(m.amount),
      createdAt: m.createdAt ?? new Date(0),
      expiresAt: m.expiresAt,
      customerPurchaseId: m.customerPurchaseId,
    })),
    compra.id,
  );

  await creditCustomer(tx, compra.customerId, monto, {
    reason: "purchase_cancelled",
    customerPurchaseId: compra.id,
    // Hereda si vino de saldo; si se pagó con plata de verdad, los 3 meses.
    expiresAt: heredado ?? vencimientoPara(ahora),
    notes: `Cancelación de "${(compra as { description?: string | null }).description ?? "una compra"}"`,
  });
  return monto;
}

/**
 * Qué cuelga de una compra. Es lo que decide si se puede borrar.
 *
 * Cuenta pagos de CUALQUIER estado, no sólo los confirmados: un cobro pendiente
 * o fallido sigue siendo una fila que quedaría apuntando a una compra que ya no
 * está. Para el saldo sólo cuentan los confirmados (`listComprasDeCliente`),
 * pero para borrar cuenta cualquier rastro.
 */
export async function getCompraDeleteImpact(db: Db, id: string): Promise<ImpactoDeBorrado> {
  const [pagos, facturas, sesiones, saldo] = await Promise.all([
    db
      .select({
        cantidad: count(),
        // COALESCE porque `sum` de cero filas es NULL, no 0.
        monto: sql<string>`coalesce(sum(${payments.amount}), 0)`,
      })
      .from(payments)
      .where(eq(payments.customerPurchaseId, id)),
    db
      .select({ cantidad: count() })
      .from(lineItems)
      .where(eq(lineItems.customerPurchaseId, id)),
    db
      .select({
        agendadas: sql<number>`count(*) filter (where ${customerPurchaseService.appointmentId} is not null)`,
        consumidas: sql<number>`count(*) filter (where ${customerPurchaseService.consumedAt} is not null)`,
      })
      .from(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, id)),
    // Movimientos de saldo a favor. Sin esto el DELETE reventaba contra el FK
    // de la 1.46.0 con un error crudo de Postgres en vez de un motivo legible.
    db
      .select({ cantidad: count() })
      .from(customerCreditMovements)
      .where(eq(customerCreditMovements.customerPurchaseId, id)),
  ]);

  return {
    pagos: Number(pagos[0]?.cantidad ?? 0),
    montoPagado: Number(pagos[0]?.monto ?? 0),
    facturas: Number(facturas[0]?.cantidad ?? 0),
    sesionesAgendadas: Number(sesiones[0]?.agendadas ?? 0),
    sesionesConsumidas: Number(sesiones[0]?.consumidas ?? 0),
    movimientosDeSaldo: Number(saldo[0]?.cantidad ?? 0),
  };
}

/**
 * Borra una compra para siempre, con sus servicios comprados.
 *
 * Vuelve a calcular el impacto acá aunque la pantalla ya lo haya consultado:
 * entre que se abre el cartel y se confirma le puede haber entrado un cobro, y
 * el navegador nunca decide si algo es borrable. Mismo criterio que el borrado
 * permanente de clientes.
 *
 * Devuelve los motivos si no se pudo. Vacío = borrada.
 */
export async function deleteCompraPermanently(db: Db, id: string): Promise<string[]> {
  const motivos = razonesParaNoBorrarCompra(await getCompraDeleteImpact(db, id));
  if (motivos.length > 0) return motivos;

  await db.transaction(async (tx) => {
    // Los servicios comprados tienen ON DELETE CASCADE, pero se borran
    // explícitamente: depender de la cascada obliga a leer el DDL para
    // entender qué pasa acá.
    await tx
      .delete(customerPurchaseService)
      .where(eq(customerPurchaseService.customerPurchaseId, id));
    await tx.delete(customerPurchase).where(eq(customerPurchase.id, id));
  });
  return [];
}

/** Una compra por id, para saber si existe antes de tocarla. */
export async function getCompraById(db: Db, id: string) {
  const [fila] = await db
    .select(compraFields)
    .from(customerPurchase)
    .where(eq(customerPurchase.id, id))
    .limit(1);
  return fila ?? null;
}

/**
 * El estado de una compra frente a la devolución: qué se pagó, qué se usó y
 * cuánto saldo le queda hoy a la clienta.
 */
export async function getEstadoDeDevolucion(db: Db, id: string): Promise<CompraParaDevolver | null> {
  const [compra] = await db
    .select({
      id: customerPurchase.id,
      customerId: customerPurchase.customerId,
      finalAmount: customerPurchase.finalAmount,
      cancelledAt: customerPurchase.cancelledAt,
    })
    .from(customerPurchase)
    .where(eq(customerPurchase.id, id))
    .limit(1);
  if (!compra) return null;

  const [cobrado, servicios, devuelta, cliente] = await Promise.all([
    db
      .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)` })
      .from(payments)
      .where(and(eq(payments.customerPurchaseId, id), eq(payments.status, "confirmed"))),
    serviciosParaSaldo(db, id),
    db
      .select({ n: count() })
      .from(customerCreditMovements)
      .where(
        and(
          eq(customerCreditMovements.customerPurchaseId, id),
          eq(customerCreditMovements.reason, "refunded"),
        ),
      ),
    compra.customerId ? getCustomerById(db, compra.customerId) : Promise.resolve(null),
  ]);

  return {
    cancelada: compra.cancelledAt != null,
    pagado: Number(cobrado[0]?.total ?? 0),
    finalAmount: Number(compra.finalAmount ?? 0),
    servicios,
    saldoDisponible: Number(cliente?.creditBalance ?? 0),
    yaDevuelta: Number(devuelta[0]?.n ?? 0) > 0,
  };
}

/**
 * Devuelve la plata en mano: baja el saldo a favor y la resta de la caja del
 * día, **en una sola transacción**.
 *
 * Las dos cosas juntas o ninguna. Si se bajara el saldo sin tocar la caja, la
 * rendición del día cerraría con plata que ya no está; al revés, la clienta
 * seguiría teniendo a favor una plata que ya se llevó.
 *
 * Vuelve a evaluar las condiciones acá aunque la pantalla ya las haya
 * consultado: entre el cartel y la confirmación la clienta pudo haber usado el
 * saldo en otra compra.
 *
 * Devuelve los motivos si no se pudo; `{ motivos: [], monto }` si se devolvió.
 */
export async function devolverPlataDeCompra(
  db: Db,
  id: string,
  ctx: { descripcion: string; notas?: string | null },
): Promise<{
  motivos: string[];
  monto: number;
  /** La nota de crédito que quedó en borrador esperando a Laura, si hizo falta. */
  notaDeCreditoId?: string | null;
  /** La factura nueva por lo que la clienta sí consumió (devolución parcial). */
  refacturaId?: string | null;
  /** true si la factura era borrador y se canceló sola. */
  borradorAnulado?: boolean;
}> {
  const estado = await getEstadoDeDevolucion(db, id);
  if (!estado) return { motivos: ["la compra no existe"], monto: 0 };

  const motivos = razonesParaNoDevolver(estado);
  if (motivos.length > 0) return { motivos, monto: 0 };

  const monto = montoADevolver(estado);
  if (monto <= 0) return { motivos: ["no hay plata para devolver"], monto: 0 };

  const [compra] = await db
    .select({ customerId: customerPurchase.customerId })
    .from(customerPurchase)
    .where(eq(customerPurchase.id, id))
    .limit(1);
  if (!compra?.customerId) return { motivos: ["la compra no tiene clienta"], monto: 0 };

  // Cómo entró la plata decide cómo sale. Antes la devolución se marcaba
  // SIEMPRE declarada, apoyada en que "ya se declaró al cobrar" — y eso no
  // siempre es cierto: un cobro sin factura entra como recibo, no declarado.
  // Devolverlo declarado dejaba la rendición con un egreso declarado que
  // ningún ingreso declarado compensaba (lo notó Pia, 2026-09-10).
  const cobros = await db
    .select({
      amount: payments.amount,
      isDeclared: payments.isDeclared,
      invoiceId: payments.invoiceId,
    })
    .from(payments)
    .where(and(eq(payments.customerPurchaseId, id), eq(payments.status, "confirmed")));

  const { declarado: montoDeclarado, noDeclarado: montoNoDeclarado } = repartirDevolucion(
    monto,
    cobros.map((p) => ({ amount: Number(p.amount), isDeclared: p.isDeclared })),
  );

  // La factura de la parte declarada. Es la que hay que acreditar.
  const facturaId = cobros.find((p) => p.isDeclared && p.invoiceId)?.invoiceId ?? null;
  const factura = facturaId ? await getInvoiceById(db, facturaId) : null;

  let notaDeCreditoId: string | null = null;
  let refacturaId: string | null = null;
  let borradorAnulado = false;

  await db.transaction(async (tx) => {
    const ok = await debitCustomerCredit(tx, compra.customerId!, monto, {
      reason: "refunded",
      customerPurchaseId: id,
      notes: ctx.notas ?? `Devolución en efectivo de "${ctx.descripcion}"`,
    });
    // La guarda de carrera: si entre la lectura y esta línea el saldo se usó
    // en otra compra, el WHERE no matchea y la transacción entera se cae. Sin
    // esto quedaría un egreso de caja sin respaldo.
    if (!ok) throw new Error("El saldo a favor cambió mientras se devolvía. Probá de nuevo.");

    // Una fila por cada mitad, como hace el cobro al partir un pago entre lo
    // facturable y lo que no. Las de $0 no se escriben.
    for (const [importe, declarado] of [
      [montoDeclarado, true],
      [montoNoDeclarado, false],
    ] as const) {
      if (importe <= 0) continue;
      await tx.insert(cashRegister).values({
        // NEGATIVO: es plata que sale. Así lo entiende la rendición del día,
        // que suma los movimientos manuales a la caja en efectivo.
        amount: dec(-importe),
        source: "refund",
        description: `Devolución a cliente — ${ctx.descripcion}`,
        isDeclared: declarado,
        status: "recorded",
        registrationDate: new Date(),
      });
    }

    if (factura && montoDeclarado > 0) {
      // Un comprobante con CAE no se acredita a medias: la nota de crédito va
      // SIEMPRE por el total de la factura, y lo que la clienta sí consumió se
      // vuelve a facturar aparte (regla de Pia, 2026-09-11). Acreditar sólo la
      // parte devuelta dejaba viva una factura por un importe que ya no era el
      // de la operación.
      const { notaPor, refacturaPor: aRefacturar } = comprobantesDeDevolucion(
        Number(factura.totalAmount ?? 0),
        montoDeclarado,
      );

      if (factura.status === "draft") {
        // Todavía no fue a ARCA: no existe fiscalmente, así que se cancela y
        // listo. Decisión de Pia (2026-09-10): que no le quede a Laura un
        // borrador fantasma esperando para emitir algo ya devuelto.
        await updateInvoice(tx, factura.id, { status: "cancelled" });
        borradorAnulado = true;
      } else {
        // Ya emitida: hace falta una NOTA DE CRÉDITO de verdad, por el TOTAL.
        // Nace en borrador y Laura la emite desde Facturas cuando quiera, con
        // el mismo botón que usa para los borradores de factura.
        const [nota] = await tx
          .insert(invoices)
          .values({
            customerId: compra.customerId,
            issuerId: factura.issuerId,
            invoiceType: factura.invoiceType,
            subtotal: dec(notaPor),
            taxAmount: "0.00",
            totalAmount: dec(notaPor),
            description: `Devolución — ${ctx.descripcion}`,
            status: "draft",
            creditNoteOf: factura.id,
            invoiceDate: new Date(),
          })
          .returning({ id: invoices.id });
        notaDeCreditoId = nota?.id ?? null;
      }

      // La refacturación por la diferencia. Vale para los dos casos de arriba:
      // si la factura era borrador, cancelarla entera perdía la parte que la
      // clienta sí consumió, y había que emitirla a mano.
      if (aRefacturar > 0) {
        const [refactura] = await tx
          .insert(invoices)
          .values({
            customerId: compra.customerId,
            issuerId: factura.issuerId,
            invoiceType: factura.invoiceType,
            subtotal: dec(aRefacturar),
            taxAmount: "0.00",
            totalAmount: dec(aRefacturar),
            description: `${ctx.descripcion} — sesiones usadas (reemplaza comprobante anulado)`,
            status: "draft",
            invoiceDate: new Date(),
          })
          .returning({ id: invoices.id });

        // Sin la línea, el PDF sale sin concepto y ARCA recibe un comprobante
        // que no dice de qué es.
        if (refactura) {
          await tx.insert(lineItems).values({
            invoiceId: refactura.id,
            description: `${ctx.descripcion} — sesiones usadas`,
            customerPurchaseId: id,
            quantity: 1,
            unitPrice: dec(aRefacturar),
            taxAmount: "0.00",
            subtotal: dec(aRefacturar),
            totalAmount: dec(aRefacturar),
          });
        }
        refacturaId = refactura?.id ?? null;
      }
    }
  });

  return { motivos: [], monto, notaDeCreditoId, refacturaId, borradorAnulado };
}

/** Lo efectivamente cobrado de una compra: la única definición del saldo. */
export async function getPagadoDeCompra(db: Db, id: string): Promise<number> {
  const [fila] = await db
    .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)` })
    .from(payments)
    .where(and(eq(payments.customerPurchaseId, id), eq(payments.status, "confirmed")));
  return Number(fila?.total ?? 0);
}
