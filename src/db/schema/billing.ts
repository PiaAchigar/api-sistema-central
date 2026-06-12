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

export const invoices = pgTable("invoices", {
  id: id(),
  customerId: uuid("customer_id"),
  issuedByUserId: uuid("issued_by_user_id"),
  invoiceNumber: integer("invoice_number"), // correlativo ARCA, se asigna al emitir
  invoiceType: varchar("invoice_type", { length: 10 }), // A | B | C
  subtotal: decimal("subtotal", { precision: 10, scale: 2 }),
  taxAmount: decimal("tax_amount", { precision: 10, scale: 2 }),
  adjustmentAmount: decimal("adjustment_amount", { precision: 10, scale: 2 }),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }),
  description: text("description"),
  status: varchar("status", { length: 50 }), // draft | emitted | paid | cancelled
  invoiceDate: timestamp("invoice_date"),
  dueDate: timestamp("due_date"),
  emittedAt: timestamp("emitted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const lineItems = pgTable("line_items", {
  id: id(),
  invoiceId: uuid("invoice_id"),
  serviceId: uuid("service_id"),
  productId: uuid("product_id"),
  trainingEnrollmentId: uuid("training_enrollment_id"),
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
  quantityInStock: integer("quantity_in_stock"),
  unitType: varchar("unit_type", { length: 50 }),
  taxCategory: varchar("tax_category", { length: 50 }),
  supplierInfo: text("supplier_info"),
  isActive: boolean("is_active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
