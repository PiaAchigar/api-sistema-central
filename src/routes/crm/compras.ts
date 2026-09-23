import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { badRequest, notFound } from "../../lib/errors";
import { auth, requireAdmin, requireAuth, requirePermission } from "../../middleware/auth";
import {
  cancelCompra,
  createCompra,
  deleteCompraPermanently,
  devolverPlataDeCompra,
  getCompraById,
  getCompraDeleteImpact,
  getEstadoDeDevolucion,
  listComprasDeCliente,
} from "../../repositories/compras.repo";
import { montoADevolver, razonesParaNoDevolver } from "../../lib/devolucion";
import { cobroDeCompra, razonesParaNoCobrar } from "../../lib/cobro-de-compra";
import { checkout } from "../../services/checkout.service";
import { resolveArcaConfig } from "../../arca/factory";
import { getPagadoDeCompra } from "../../repositories/compras.repo";
import { razonesParaNoBorrarCompra } from "../../lib/compra-borrado";
import {
  listCatalogoVendible,
  listPromosVendibles,
  motivoPromoNoVendible,
  obtenerItemVendible,
  obtenerPromoVendible,
  preciosDeListaDe,
} from "../../repositories/catalogo-venta.repo";
import { sexoDeLaClienta } from "../../repositories/clientes-sexo.repo";
import { cotizar } from "../../lib/cotizacion";
import { cotizarPaquete, razonParaNoVenderElPaquete } from "../../lib/cotizacion-de-paquete";
import { razonParaNoAplicarPromoSuelta } from "../../lib/promo-aplica";
import type { AppBindings, Variables } from "../../env";

const comprasRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

/**
 * Las compras de una clienta: qué adquirió, cuánto pagó, cuánto debe y en qué
 * estado está cada sesión. Alimenta la card "Compras del Cliente".
 */
comprasRouter.get(
  "/customers/:id/purchases",
  auth,
  requireAuth,
  requirePermission("crm", "view"),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await listComprasDeCliente(db, c.req.param("id")));
  },
);

/**
 * Todo lo que se puede vender, en una sola forma, más las promos vigentes.
 *
 * Va acá y no en `/api/agenda/...` por dos motivos: el permiso es el de quien
 * vende (`crm`), y así la pantalla de venta hace UNA llamada en vez de cuatro
 * a rutas de secciones distintas.
 */
comprasRouter.get(
  "/purchases/catalog",
  auth,
  requireAuth,
  requirePermission("crm", "view"),
  async (c) => {
    const db = createDb(c.env);
    const [catalogo, promociones] = await Promise.all([
      listCatalogoVendible(db),
      listPromosVendibles(db),
    ]);
    return c.json({ ...catalogo, promociones });
  },
);

/**
 * Cotiza sin vender: cuánto sale esto, con este descuento, hasta cuándo vale.
 *
 * La cuenta corre acá y no en el navegador porque el precio sale del catálogo
 * —zonas de depilación, líneas de combo, política global— y espejar todo eso
 * en front-crm sería una segunda copia que se desincroniza sola. Lo que sí se
 * mantiene del diseño es que la venta CONGELA lo cotizado: la pantalla manda
 * de vuelta estos tres montos, que son los que Laura vio.
 */
comprasRouter.post(
  "/purchases/quote",
  auth,
  requireAuth,
  requirePermission("crm", "view"),
  zValidator(
    "json",
    z.union([
      z.object({
        origen: z.enum(["combo", "depilacion", "servicio", "capacitacion"]),
        id: z.string().uuid(),
        sessions: z.number().int().positive(),
        promotionId: z.string().uuid().nullish(),
        customerId: z.string().uuid(),
      }),
      // Un paquete no tiene "origen": lo que lleva sale de la promo.
      z.object({
        origen: z.literal("paquete"),
        promotionId: z.string().uuid(),
        customerId: z.string().uuid(),
      }),
    ]),
  ),
  async (c) => {
    const db = createDb(c.env);
    const body = c.req.valid("json");

    if (body.origen === "paquete") {
      const promo = await obtenerPromoVendible(db, body.promotionId);
      if (!promo) throw badRequest(await motivoPromoNoVendible(db, body.promotionId));
      try {
        // Sólo depilación cobra distinto según a quién se le vende (ver el
        // camino suelto, más abajo): se resuelve acá para que el pack de
        // depilación adentro del paquete pese lo que ESA clienta paga.
        const sexo = await sexoDeLaClienta(db, body.customerId);
        const q = cotizarPaquete(promo, await preciosDeListaDe(db, promo.destinos, sexo), new Date());
        return c.json({
          ...q,
          expiresAt: null,
          // Listo para mandarlo a POST /purchases sin rearmarlo, igual que la
          // forma vieja.
          esPaquete: true,
          comboId: null,
          depilationComboId: null,
          serviceId: null,
          trainingId: null,
        });
      } catch (e) {
        throw badRequest((e as Error).message);
      }
    }

    const { origen, id, sessions, promotionId, customerId } = body;

    // Sólo depilación cobra distinto según a quién se le vende; se resuelve
    // una vez acá y se le pasa a quien resuelve el item, en vez de que cada
    // origen tenga que saber de dónde sale.
    const sexo = await sexoDeLaClienta(db, customerId);
    const item = await obtenerItemVendible(db, origen, id, sexo);
    if (!item) {
      throw notFound(
        origen === "servicio" ? "Servicio" : origen === "capacitacion" ? "Capacitación" : "Combo",
      );
    }

    // Una promo que no está vigente no se aplica en silencio: se avisa, porque
    // el precio que Laura ve es el que se va a congelar.
    let promo = null;
    if (promotionId) {
      promo = await obtenerPromoVendible(db, promotionId);
      // El motivo se busca aparte: vencida y agotada no son lo mismo y el
      // cartel tiene que decir cuál de las dos es (ver motivoPromoNoVendible).
      if (!promo) throw badRequest(await motivoPromoNoVendible(db, promotionId));
      // La pantalla ya filtra, pero una pantalla abierta hace media hora
      // puede ofrecer una promo que ya venció o se agotó. Es plata: se
      // vuelve a chequear acá.
      const razon = razonParaNoAplicarPromoSuelta(promo, { origen, id });
      if (razon) throw badRequest(razon);
    }

    try {
      const q = cotizar(item, sessions, promo, new Date());
      return c.json({
        ...q,
        expiresAt: q.expiresAt?.toISOString() ?? null,
        // Ya listo para mandarlo a POST /purchases sin rearmarlo.
        comboId: origen === "combo" ? id : null,
        depilationComboId: origen === "depilacion" ? id : null,
        serviceId: origen === "servicio" ? id : null,
        trainingId: origen === "capacitacion" ? id : null,
      });
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  },
);

/**
 * Vende.
 *
 * Los tres montos llegan YA CALCULADOS y acá se congelan. El motor
 * (`lib/pack-pricing.ts`) corre del lado de quien vende, que es el que sabe
 * qué promo eligió Laura y qué política de pack corre; el backend guarda el
 * precio, nunca la fórmula que lo produjo. Eso es lo que hace que la venta
 * sobreviva a cualquier cambio de precios o de motor.
 */
export const compraBody = z
  .object({
    customerId: z.string().uuid(),
    comboId: z.string().uuid().nullish(),
    serviceId: z.string().uuid().nullish(),
    depilationComboId: z.string().uuid().nullish(),
    trainingId: z.string().uuid().nullish(),
    esPaquete: z.boolean().optional(),
    description: z.string().min(1).max(200),
    sessionsTotal: z.number().int().positive(),
    baseAmount: z.number().nonnegative(),
    discountedAmount: z.number().nonnegative(),
    finalAmount: z.number().nonnegative(),
    promotionId: z.string().uuid().nullish(),
    expiresAt: z.string().datetime({ offset: true }).nullish(),
    notes: z.string().max(2000).nullish(),
    /** Cuánto del saldo a favor aplicar. El backend lo topea igual. */
    usarSaldo: z.number().nonnegative().nullish(),
  })
  .refine(
    (v) => {
      const sueltos = [v.comboId, v.serviceId, v.depilationComboId, v.trainingId].filter(Boolean);
      // Un paquete no tiene origen suelto: lo que lleva sale de la promo.
      if (v.esPaquete) return sueltos.length === 0 && !!v.promotionId;
      return sueltos.length === 1;
    },
    {
      message:
        "Una compra tiene exactamente un origen: combo, servicio, combo de depilación o capacitación. " +
        "Un paquete de promo no lleva ninguno, pero sí la promo.",
    },
  )
  .refine((v) => v.finalAmount <= v.discountedAmount && v.discountedAmount <= v.baseAmount, {
    // Los tres montos son las tres capas en orden. Si vinieran desordenados,
    // la card mostraría un "descuento" que en realidad es un recargo.
    message: "Los montos tienen que ir de mayor a menor: base ≥ con descuento ≥ final",
  });

comprasRouter.post(
  "/purchases",
  auth,
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator("json", compraBody),
  async (c) => {
    const db = createDb(c.env);
    const b = c.req.valid("json");

    // Sólo depilación cobra distinto según a quién se le vende, pero se
    // resuelve UNA vez acá, para los dos caminos: si el pack de depilación va
    // suelto o adentro de un paquete, la venta tiene que pesarlo igual que lo
    // vio Laura al cotizar.
    const sexo = await sexoDeLaClienta(db, b.customerId);

    if (b.esPaquete) {
      const promo = await obtenerPromoVendible(db, b.promotionId!);
      if (!promo) throw badRequest(await motivoPromoNoVendible(db, b.promotionId!));
      // El `finalAmount` que llega no sólo se congela: es el número que
      // `lineasDeUnPaquete` reparte entre las líneas. El servidor ya releyó la
      // promo y tiene el precio autoritativo, así que una discrepancia se
      // rechaza en vez de pisarse en silencio (ver la función).
      const razon = razonParaNoVenderElPaquete(promo, b.finalAmount);
      if (razon) throw badRequest(razon);
      try {
        const compra = await createCompra(db, {
          ...b,
          sexo,
          promotionName: promo.name ?? null,
          expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
        });
        return c.json(compra, 201);
      } catch (e) {
        throw badRequest((e as Error).message);
      }
    }

    // Mismo origen/id que validó el CHECK de arriba (exactamente uno de los
    // cuatro), para poder chequear la promo contra sus destinos.
    const origen = b.comboId
      ? "combo"
      : b.serviceId
        ? "servicio"
        : b.depilationComboId
          ? "depilacion"
          : "capacitacion";
    const id = b.comboId ?? b.serviceId ?? b.depilationComboId ?? b.trainingId ?? "";

    let promo = null;
    if (b.promotionId) {
      promo = await obtenerPromoVendible(db, b.promotionId);
      if (!promo) throw badRequest(await motivoPromoNoVendible(db, b.promotionId));
      // La pantalla ya filtra, pero una pantalla abierta hace media hora
      // puede ofrecer una promo que ya venció o se agotó. Es plata: se
      // vuelve a chequear acá. Y una promo de PAQUETE no se aplica por este
      // camino: matchearía (sus destinos SON estos items) sin descontar nada,
      // gastándole un uso del cupo a un paquete que nadie vendió.
      const razon = razonParaNoAplicarPromoSuelta(promo, { origen, id });
      if (razon) throw badRequest(razon);
    }

    try {
      const compra = await createCompra(db, {
        ...b,
        sexo,
        promotionName: promo?.name ?? null,
        expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
      });
      return c.json(compra, 201);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  },
);

/**
 * Cancela una compra. No borra: puede tener pagos y facturas colgando, y una
 * venta cancelada sigue siendo parte de la historia de la clienta.
 */
comprasRouter.post(
  "/purchases/:id/cancel",
  auth,
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator("json", z.object({ reason: z.string().max(500).nullish() }).optional()),
  async (c) => {
    const db = createDb(c.env);
    const cancelada = await cancelCompra(db, c.req.param("id"), c.req.valid("json")?.reason);
    // null = no existe, o ya estaba cancelada. Las dos son "no hay nada que
    // cancelar acá"; distinguirlas no le cambia nada a quien lo pide.
    if (!cancelada) throw notFound("Compra");
    return c.json(cancelada);
  },
);

/**
 * Qué cuelga de una compra, para que el cartel diga por qué no se puede borrar
 * antes de que Laura apriete nada.
 */
comprasRouter.get(
  "/purchases/:id/delete-impact",
  auth,
  requireAuth,
  requirePermission("crm", "view"),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    if (!(await getCompraById(db, id))) throw notFound("Compra");

    const impacto = await getCompraDeleteImpact(db, id);
    const motivos = razonesParaNoBorrarCompra(impacto);
    return c.json({ ...impacto, motivos, borrable: motivos.length === 0 });
  },
);

/**
 * Borra una compra para siempre. Es para lo que NUNCA DEBIÓ EXISTIR —una venta
 * cargada por error— y por eso no deja rastro: no hay nada que contar.
 *
 * Si algo cuelga (un cobro, una factura, un turno), no se borra: eso pasó de
 * verdad y se cancela, que sí deja el registro.
 *
 * El permiso es el mismo que vender (`crm.edit`) y no admin: lo que protege
 * acá es la guarda de impacto, no el rol. Si sólo el admin pudiera limpiar un
 * error de tipeo, el error se quedaría en la ficha para siempre — que es
 * justamente lo que este botón viene a evitar.
 */
comprasRouter.delete(
  "/purchases/:id",
  auth,
  requireAuth,
  requirePermission("crm", "edit"),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    if (!(await getCompraById(db, id))) throw notFound("Compra");

    const motivos = await deleteCompraPermanently(db, id);
    if (motivos.length > 0) {
      throw badRequest(`No se puede eliminar esta compra porque ${motivos.join(", ")}.`);
    }
    return c.body(null, 204);
  },
);

/**
 * Si a esta compra se le puede devolver la plata, cuánta, y si no por qué.
 * Lo consulta el cartel antes de ofrecer nada.
 */
comprasRouter.get(
  "/purchases/:id/refund-check",
  auth,
  requireAuth,
  requirePermission("crm", "view"),
  async (c) => {
    const db = createDb(c.env);
    const estado = await getEstadoDeDevolucion(db, c.req.param("id"));
    if (!estado) throw notFound("Compra");

    const motivos = razonesParaNoDevolver(estado);
    return c.json({
      ...estado,
      motivos,
      sePuede: motivos.length === 0,
      monto: motivos.length === 0 ? montoADevolver(estado) : 0,
    });
  },
);

/**
 * Devuelve la plata en mano: baja el saldo a favor y la resta de la caja del
 * día, en una sola transacción.
 *
 * **Sólo admin**, a diferencia de vender y cancelar (decisión de Pia,
 * 2026-09-09): es la única acción de todo el flujo que saca plata del local.
 *
 * Es el último recurso. Lo primero que se le ofrece a la clienta es usar el
 * saldo en otro tratamiento, y para eso no hace falta pasar por acá.
 */
comprasRouter.post(
  "/purchases/:id/refund",
  auth,
  requireAuth,
  requireAdmin,
  zValidator("json", z.object({ notes: z.string().max(500).nullish() }).optional()),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const compra = await getCompraById(db, id);
    if (!compra) throw notFound("Compra");

    const { motivos, monto, notaDeCreditoId, refacturaId, borradorAnulado } =
      await devolverPlataDeCompra(
      db,
      id,
      {
        descripcion: compra.description ?? "una compra",
        notas: c.req.valid("json")?.notes,
      },
    );
    if (motivos.length > 0) {
      throw badRequest(`No se puede devolver la plata porque ${motivos.join(", ")}.`);
    }
    // El front avisa qué quedó pendiente: si la compra estaba facturada en
    // ARCA, hay una nota de crédito en borrador esperando en el facturador.
    return c.json({ monto, notaDeCreditoId, refacturaId, borradorAnulado });
  },
);

/**
 * Cobra una compra: reutiliza el MISMO `checkout()` del mostrador.
 *
 * No duplica nada de facturación. Ese servicio ya resuelve la factura ARCA
 * cuando va el tilde "lleva factura", el split declarado/no declarado, el
 * movimiento de caja y las líneas de detalle; acá sólo se le arma la entrada a
 * partir de la compra, que es lo único que él no sabe.
 *
 * La línea va como CONCEPTO LIBRE con la descripción congelada de la compra:
 * un pack de depilación no es un `service` ni un `product`, así que sin eso no
 * había forma de nombrarlo en la factura.
 */
comprasRouter.post(
  "/purchases/:id/checkout",
  auth,
  requireAuth,
  requirePermission("crm", "edit"),
  zValidator(
    "json",
    z.object({
      amount: z.number().positive(),
      method: z.enum(["cash", "bank_transfer", "mercadopago", "debit_card", "credit_card"]),
      wantsInvoice: z.boolean().default(false),
      issuerId: z.string().uuid().nullish(),
      notes: z.string().max(500).nullish(),
    }),
  ),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const compra = await getCompraById(db, id);
    if (!compra) throw notFound("Compra");
    if (compra.cancelledAt) throw badRequest("Esta compra está cancelada");
    if (!compra.customerId) throw badRequest("La compra no tiene clienta");

    const b = c.req.valid("json");
    const estado = {
      finalAmount: Number(compra.finalAmount ?? 0),
      yaPagado: await getPagadoDeCompra(db, id),
    };
    const motivos = razonesParaNoCobrar(b.amount, estado);
    if (motivos.length > 0) throw badRequest(`No se puede cobrar: ${motivos.join(", ")}.`);

    const arca = await resolveArcaConfig(db, c.env, b.issuerId ?? undefined);
    const resultado = await checkout(db, arca, {
      customerId: compra.customerId,
      customerPurchaseId: id,
      issuerId: b.issuerId ?? undefined,
      items: [
        {
          description: compra.description ?? "Compra",
          customerPurchaseId: id,
          quantity: 1,
          unitPrice: b.amount,
        },
      ],
      payment: { method: b.method, amount: b.amount, wantsInvoice: b.wantsInvoice },
      notes: b.notes ?? undefined,
    });

    return c.json({ ...resultado, ...cobroDeCompra({ ...estado, yaPagado: estado.yaPagado + b.amount }) }, 201);
  },
);

/** Cuánto falta cobrar de esta compra y cuál es el mínimo de ahora. */
comprasRouter.get(
  "/purchases/:id/checkout-state",
  auth,
  requireAuth,
  requirePermission("crm", "view"),
  async (c) => {
    const db = createDb(c.env);
    const id = c.req.param("id");
    const compra = await getCompraById(db, id);
    if (!compra) throw notFound("Compra");
    return c.json(
      cobroDeCompra({
        finalAmount: Number(compra.finalAmount ?? 0),
        yaPagado: await getPagadoDeCompra(db, id),
      }),
    );
  },
);

export { comprasRouter };
