import {
  boolean,
  decimal,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at").$defaultFn(() => new Date());
const updatedAt = () =>
  timestamp("updated_at")
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());

/**
 * Identidades fiscales que pueden emitir (una por persona/razón social + punto
 * de venta). `sdkToken/cert/key` están CIFRADOS con AES-GCM — ver lib/secret-box.ts.
 * Nunca se devuelven por la API ni se loguean.
 */
export const arcaIssuers = pgTable("arca_issuers", {
  id: id(),
  name: varchar("name", { length: 100 }),
  cuit: varchar("cuit", { length: 20 }),
  sdkTokenEnc: text("sdk_token_enc"),
  certEnc: text("cert_enc"),
  keyEnc: text("key_enc"),
  environment: varchar("environment", { length: 10 }), // homo | prod
  pointOfSale: integer("point_of_sale"),
  invoiceType: varchar("invoice_type", { length: 10 }), // A | B | C
  isActive: boolean("is_active"),
  isDefault: boolean("is_default"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const invoices = pgTable("invoices", {
  id: id(),
  customerId: uuid("customer_id"),
  issuedByUserId: uuid("issued_by_user_id"),
  /** Facturador (identidad ARCA) con el que se emite. NULL = facturas previas al multi-facturador. */
  issuerId: uuid("issuer_id"),
  invoiceNumber: integer("invoice_number"), // correlativo ARCA, se asigna al emitir
  invoiceType: varchar("invoice_type", { length: 10 }), // A | B | C
  subtotal: decimal("subtotal", { precision: 10, scale: 2 }),
  taxAmount: decimal("tax_amount", { precision: 10, scale: 2 }),
  adjustmentAmount: decimal("adjustment_amount", { precision: 10, scale: 2 }),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }),
  description: text("description"),
  status: varchar("status", { length: 50 }), // draft | emitted | paid | cancelled
  /** Si no es NULL, esta fila es una NOTA DE CRÉDITO de la factura apuntada
   *  (1.49.0). En ARCA una nota de crédito es un comprobante propio, con su
   *  tipo (C=13) y su numeración, así que vive acá y no en una tabla aparte.
   *  El monto puede ser menor al original: una devolución puede ser parcial. */
  creditNoteOf: uuid("credit_note_of"),
  invoiceDate: timestamp("invoice_date"),
  dueDate: timestamp("due_date"),
  emittedAt: timestamp("emitted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const lineItems = pgTable("line_items", {
  id: id(),
  invoiceId: uuid("invoice_id"),
  /** Concepto propio de la línea (ej: "Seña de servicio: X"). Si es NULL se
   *  muestra el nombre del servicio/producto asociado. */
  description: varchar("description", { length: 255 }),
  /** Cobro que pagó esta línea. Las líneas NO facturadas a ARCA viven solo acá
   *  (invoiceId en NULL): son un recibo, no un comprobante fiscal. */
  paymentId: uuid("payment_id"),
  serviceId: uuid("service_id"),
  productId: uuid("product_id"),
  trainingEnrollmentId: uuid("training_enrollment_id"),
  /** Compra que factura esta línea (1.45.0). Una compra puede tener VARIAS
   *  facturas, así que el vínculo vive acá y no en `customer_purchase`. */
  customerPurchaseId: uuid("customer_purchase_id"),
  quantity: integer("quantity"),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }), // snapshot al momento de la venta
  taxAmount: decimal("tax_amount", { precision: 10, scale: 2 }),
  subtotal: decimal("subtotal", { precision: 10, scale: 2 }),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const payments = pgTable("payments", {
  id: id(),
  invoiceId: uuid("invoice_id"),
  /** De quién es el cobro. Se guarda siempre, haya factura o no (la parte no
   *  declarada de una cobranza mixta no tiene factura de la cual deducirlo). */
  customerId: uuid("customer_id"),
  paymentAccountId: uuid("payment_account_id"),
  amount: decimal("amount", { precision: 10, scale: 2 }),
  paymentMethod: varchar("payment_method", { length: 50 }), // cash | bank_transfer | mercadopago
  status: varchar("status", { length: 50 }), // pending | confirmed | failed | refunded
  paymentDate: timestamp("payment_date"),
  reference: varchar("reference", { length: 255 }),
  notes: text("notes"),
  isDeclared: boolean("is_declared"),
  // Si el cliente transfirió directo a la profesional (comisión), no se factura a PiuBella
  receivedByProviderId: uuid("received_by_provider_id"),
  // Turno cobrado en este pago (si vino de un checkout con appointmentId) — permite
  // mostrar en caja cuánto de este cobro es la comisión de la proveedora.
  appointmentId: uuid("appointment_id"),
  /** Compra que paga este cobro (1.45.0). Con esto el saldo tiene UNA sola
   *  definición: final_amount − Σ amount de los pagos confirmados. */
  customerPurchaseId: uuid("customer_purchase_id"),
  confirmedByUserId: uuid("confirmed_by_user_id"),
  confirmedAt: timestamp("confirmed_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const arcaLogs = pgTable("arca_logs", {
  id: id(),
  invoiceId: uuid("invoice_id"),
  cae: varchar("cae", { length: 100 }),
  caeExpiry: timestamp("cae_expiry"),
  arcaResponseCode: varchar("arca_response_code", { length: 50 }),
  arcaFullResponse: jsonb("arca_full_response"),
  retryCount: integer("retry_count"),
  lastRetryAt: timestamp("last_retry_at"),
  status: varchar("status", { length: 50 }), // pending | success | failed
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const cashRegister = pgTable("cash_register", {
  id: id(),
  paymentId: uuid("payment_id"),
  amount: decimal("amount", { precision: 10, scale: 2 }),
  source: varchar("source", { length: 50 }), // customer_payment | refund | deposit | other
  description: text("description"),
  isDeclared: boolean("is_declared"),
  registeredByUserId: uuid("registered_by_user_id"),
  status: varchar("status", { length: 50 }), // pending | recorded | reconciled | archived
  registrationDate: timestamp("registration_date"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const products = pgTable("products", {
  id: id(),
  name: varchar("name", { length: 255 }),
  description: varchar("description", { length: 255 }),
  code: varchar("code", { length: 50 }),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }),
  // numeric(10,3) desde la 1.44.0: las recetas consumen fracciones (media
  // ampolla) y con integer el stock se iría desviando en cada servicio.
  quantityInStock: decimal("quantity_in_stock", { precision: 10, scale: 3 }),
  unitType: varchar("unit_type", { length: 50 }),
  taxCategory: varchar("tax_category", { length: 50 }),
  supplierInfo: text("supplier_info"),
  isActive: boolean("is_active"),
  // ── Insumos (1.41.0) ──────────────────────────────────────────────────────
  // `unit_price` es a cuánto se VENDE (lo lee invoicing.service para facturar);
  // `unitCost` es lo que CUESTA, que es lo que se usa para costear tratamientos.
  // Son dos números distintos y meterlos en la misma columna facturaría los
  // insumos al precio de compra.
  unitCost: decimal("unit_cost", { precision: 10, scale: 2 }),
  /** Unidades a partir de las cuales avisar. NULL o 0 = "no me avises". */
  minimumStock: integer("minimum_stock"),
  /** true = se consume haciendo un servicio. Separa los insumos de los
   *  productos vendibles: `line_items.product_id` referencia esta misma tabla. */
  isSupply: boolean("is_supply"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Cuentas de MercadoPago. Pertenecen a una service_provider (la dueña entra como
// proveedora). Relación 1:N: una proveedora puede tener varias cuentas.
export const mercadopagoAccounts = pgTable("mercadopago_accounts", {
  id: id(),
  serviceProviderId: uuid("service_provider_id"),
  mercadopagoUserId: varchar("mercadopago_user_id", { length: 100 }),
  accountOwnerName: varchar("account_owner_name", { length: 255 }),
  accountEmail: varchar("account_email", { length: 255 }),
  alias: varchar("alias", { length: 255 }),
  cvu: varchar("cvu", { length: 34 }),
  accessTokenEncrypted: varchar("access_token_encrypted", { length: 255 }),
  publicKeyEncrypted: varchar("public_key_encrypted", { length: 255 }),
  status: varchar("status", { length: 50 }), // active | inactive | pending_verification
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Lo que la clienta compró (1.45.0): un pack, un combo o un servicio suelto que
 * queda pendiente de pagar o de consumir.
 *
 * Se distingue del checkout de mostrador por una sola pregunta: ¿queda algo
 * pendiente cuando la clienta se va? (decisión de Pia, 2026-09-08).
 *
 * `description` va CONGELADA: si mañana se renombra el combo, la venta de
 * agosto tiene que seguir diciendo qué se vendió. El FK sirve para trazar; el
 * texto, para leer. Y no hay `invoiceId` porque una compra puede tener VARIAS
 * facturas — el vínculo va por `lineItems.customerPurchaseId`.
 */
export const customerPurchase = pgTable("customer_purchase", {
  id: id(),
  customerId: uuid("customer_id"),
  comboId: uuid("combo_id"),
  serviceId: uuid("service_id"),
  depilationComboId: uuid("depilation_combo_id"),
  /** Capacitación vendida (1.48.0). Cuarto origen, previsto por el diseño. */
  trainingId: uuid("training_id"),
  description: varchar("description", { length: 200 }),
  sessionsTotal: integer("sessions_total"),
  baseAmount: decimal("base_amount", { precision: 10, scale: 2 }),
  discountedAmount: decimal("discounted_amount", { precision: 10, scale: 2 }),
  promotionId: uuid("promotion_id"),
  /** El nombre de la promo, congelado al vender (1.53.0). La compra cuenta su
   *  propia historia aunque después la promo se edite o se borre. */
  promotionName: varchar("promotion_name", { length: 255 }),
  finalAmount: decimal("final_amount", { precision: 10, scale: 2 }),
  purchasedAt: timestamp("purchased_at"),
  expiresAt: timestamp("expires_at"),
  cancelledAt: timestamp("cancelled_at"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Un servicio comprado. Cuando tiene `appointmentId`, ESA fila es una sesión
 * — ver el vocabulario del spec 2026-09-11 §2: la sesión es un servicio con
 * fecha y hora, no la vuelta del pack.
 *
 * Reemplaza a `customer_purchase_session` (1.51.0), que guardaba una fila por
 * repetición y por eso no podía con un combo de dos servicios.
 */
export const customerPurchaseService = pgTable("customer_purchase_service", {
  id: id(),
  customerPurchaseId: uuid("customer_purchase_id"),
  serviceId: uuid("service_id"),
  repeticion: integer("repeticion"),
  orden: integer("orden"),
  appointmentId: uuid("appointment_id"),
  consumedAt: timestamp("consumed_at"),
  // Lo que valía este servicio al venderse (1.52.0). Congelado, como
  // `final_amount` de la compra: si mañana se edita el combo, la cuenta de
  // una compra vieja no puede cambiar sola. Es lo que hace que al cancelar el
  // saldo a favor pese cada servicio por su precio y no reparta en partes
  // iguales algo que vale distinto. NULL = la compra no se desglosa en
  // servicios con precio propio (depilación, capacitaciones).
  price: decimal("price", { precision: 10, scale: 2 }),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A qué le aplica una promo (1.45.0): servicio, zona de depilación, combo o
 * combo de depilación. Combo y pack comparten columna a propósito — un pack de
 * catálogo ES una fila de `combos`; la diferencia está en los datos de esa
 * fila, no en a qué tabla pertenece.
 */
export const promotionTarget = pgTable("promotion_target", {
  id: id(),
  promotionId: uuid("promotion_id"),
  serviceId: uuid("service_id"),
  bodyZoneId: uuid("body_zone_id"),
  comboId: uuid("combo_id"),
  depilationComboId: uuid("depilation_combo_id"),
  createdAt: createdAt(),
});
