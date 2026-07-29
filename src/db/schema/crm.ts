import {
  boolean,
  date,
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

export const contacts = pgTable("contacts", {
  id: id(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  whatsappId: varchar("whatsapp_id", { length: 255 }),
  instagramId: varchar("instagram_id", { length: 255 }),
  facebookId: varchar("facebook_id", { length: 255 }),
  telegramId: varchar("telegram_id", { length: 255 }),
  customFieldsJson: jsonb("custom_fields_json"),
  tags: text("tags").array(),
  isArchived: boolean("is_archived"),
  birthdate: date("birthdate"),
  address: varchar("address", { length: 255 }),
  city: varchar("city", { length: 255 }),
  postalCode: varchar("postal_code", { length: 50 }),
  country: varchar("country", { length: 50 }),
  status: varchar("status", { length: 50 }), // prospect | customer | inactive
  firstContactDate: timestamp("first_contact_date"),
  lastVisitDate: date("last_visit_date"),
  preferredService: varchar("preferred_service", { length: 255 }),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const customers = pgTable("customers", {
  id: id(),
  contactId: uuid("contact_id"),
  dni: varchar("dni", { length: 50 }),
  cuit: varchar("cuit", { length: 50 }),
  firstPurchaseDate: timestamp("first_purchase_date"),
  creditBalance: decimal("credit_balance", { precision: 10, scale: 2 })
    .notNull()
    .default("0"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Se usa desde el facturador para las SEÑAS: al reservar un turno con seña se
// crea un deal (senia_amount / senia_paid) vinculado al appointment. El resto
// de las columnas del pipeline CRM (stage, probability, nps…) no se mapean acá.
export const deals = pgTable("deals", {
  id: id(),
  contactId: uuid("contact_id"),
  appointmentId: uuid("appointment_id"),
  title: varchar("title", { length: 255 }),
  serviceName: varchar("service_name", { length: 255 }),
  servicePrice: decimal("service_price", { precision: 10, scale: 2 }),
  seniaAmount: decimal("senia_amount", { precision: 10, scale: 2 }),
  seniaPaid: boolean("senia_paid"),
  seniaPaidDate: timestamp("senia_paid_date"),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }),
  amountPaid: decimal("amount_paid", { precision: 10, scale: 2 }),
  amountPending: decimal("amount_pending", { precision: 10, scale: 2 }),
  paymentMethod: varchar("payment_method", { length: 50 }),
  cancelled: boolean("cancelled"),
  stage: varchar("stage", { length: 30 }).notNull().default("lead"),
  assignedAgentId: uuid("assigned_agent_id"),
  cancelReason: text("cancel_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: id(),
  authId: uuid("auth_id"),
  email: varchar("email", { length: 255 }),
  fullName: varchar("full_name", { length: 255 }),
  role: varchar("role", { length: 50 }), // admin | accountant | sales | operator
  isActive: boolean("is_active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const companyConfig = pgTable("company_config", {
  id: id(),
  companyName: varchar("company_name", { length: 255 }),
  companyDescription: varchar("company_description", { length: 255 }),
  heroTitle: varchar("hero_title", { length: 255 }),
  heroSubtitle: varchar("hero_subtitle", { length: 500 }),
  aboutUs: text("about_us"),
  address: varchar("address", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 255 }),
  website: varchar("website", { length: 255 }),
  instagram: varchar("instagram", { length: 255 }),
  facebook: varchar("facebook", { length: 255 }),
  whatsapp: varchar("whatsapp", { length: 50 }),
  lastModifiedAt: timestamp("last_modified_at"),
});

export const faq = pgTable("faq", {
  id: id(),
  question: varchar("question", { length: 255 }),
  answer: text("answer"),
  category: varchar("category", { length: 100 }),
  isActive: boolean("is_active"),
  displayOrder: integer("display_order"),
  keywords: text("keywords").array(),
  createdByUserId: uuid("created_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Fase 3: config no-secreta por canal. Los secretos (encrypted_credentials)
// se dejan NULL hasta Fase 6. Una fila por channel_type (índice único).
export const channelCredentials = pgTable("channel_credentials", {
  id: id(),
  channelType: varchar("channel_type", { length: 50 }),
  encryptedCredentials: text("encrypted_credentials"),
  configJson: jsonb("config_json"),
  isActive: boolean("is_active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const conversations = pgTable("conversations", {
  id: id(),
  contactId: uuid("contact_id"),
  channel: varchar("channel", { length: 50 }),
  status: varchar("status", { length: 50 }),
  assignedAgentId: uuid("assigned_agent_id"),
  messageCount: integer("message_count"),
  lastMessageAt: timestamp("last_message_at"),
  createdAt: createdAt(),
});

export const messages = pgTable("messages", {
  id: id(),
  conversationId: uuid("conversation_id"),
  senderType: varchar("sender_type", { length: 50 }),
  content: text("content"),
  mediaUrl: varchar("media_url", { length: 255 }),
  createdAt: createdAt(),
});

export const automationRules = pgTable("automation_rules", {
  id: id(),
  name: varchar("name", { length: 255 }),
  isActive: boolean("is_active"),
  triggerType: varchar("trigger_type", { length: 50 }),
  conditions: jsonb("conditions"),
  actionType: varchar("action_type", { length: 50 }),
  actionConfig: jsonb("action_config"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const automationRuns = pgTable("automation_runs", {
  id: id(),
  ruleId: uuid("rule_id"),
  triggerType: varchar("trigger_type", { length: 50 }),
  contactId: uuid("contact_id"),
  conversationId: uuid("conversation_id"),
  dealId: uuid("deal_id"),
  status: varchar("status", { length: 50 }),
  detail: text("detail"),
  createdAt: createdAt(),
});
