import {
  boolean,
  date,
  decimal,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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

// Credenciales de proveedores de IA (Anthropic, OpenAI) para uso de otros
// sistemas (cloud function RAG, script Python, chatbot n8n). `apiKey` se
// guarda encriptada (AES-GCM vía crypto.service, misma master key que
// channel_credentials: CREDENTIALS_ENCRYPTION_KEY) — nunca se expone cruda en
// una respuesta HTTP. Índice único (provider) WHERE is_active definido en la
// migración 1.4.0/rag-infrastructure.sql: solo una credencial activa por
// proveedor a la vez.
export const aiProviderCredentials = pgTable("ai_provider_credentials", {
  id: id(),
  provider: varchar("provider", { length: 50 }),
  apiKey: text("api_key"),
  model: varchar("model", { length: 100 }),
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
  externalId: varchar("external_id", { length: 255 }),
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

export const automationFaqs = pgTable("automation_faqs", {
  id: id(),
  question: varchar("question", { length: 255 }),
  answer: text("answer"),
  keywords: text("keywords").array(),
  isActive: boolean("is_active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Migración 1.21.0 (whatsapp-reliability.sql). Auditoría de cada intento de
// envío de WhatsApp (éxito/fallo/reintento) — la usa whatsapp-retry.service
// para loguear cada intento del backoff exponencial (1s/5s/30s, máx 3). Se
// limpia semanalmente (7+ días) vía pg_cron en Supabase.
// El CHECK real de `status` vive en la migración SQL, no acá: drizzle-orm
// pg-core no expone un builder `.check()` en esta versión (0.36.4) — mismo
// patrón que el resto de columnas "enum-string" del archivo (ver `status` en
// deals/conversations/messages, todas varchar + comentario).
export const deliveryLogs = pgTable("delivery_logs", {
  id: id(),
  messageId: uuid("message_id"),
  conversationId: uuid("conversation_id").notNull(),
  contactId: uuid("contact_id"),
  channel: varchar("channel", { length: 20 }).notNull().default("whatsapp"),
  status: varchar("status", { length: 20 }).notNull(), // success | failed | retry
  metaErrorCode: integer("meta_error_code"),
  metaErrorMessage: text("meta_error_message"),
  retryAttempt: integer("retry_attempt").notNull().default(1),
  httpStatusCode: integer("http_status_code"),
  createdAt: createdAt(),
});

// Migración 1.21.0 (whatsapp-reliability.sql, misma migración que
// delivery_logs arriba). Cola interna de mensajes pendientes de enviar por
// WhatsApp — la usan las automatizaciones masivas (ofertas, recordatorios a
// muchos contactos) para no bloquear el request que las dispara: insertan acá
// (rápido) y el worker background (queue-processor.ts) procesa la cola cada
// corrida de cron, máx 10 mensajes por vez, para respetar el rate limit de
// automatizaciones (10 msgs/min). Igual que deliveryLogs, el CHECK real de
// `sender_type`/`status` vive en la migración SQL: drizzle-orm 0.36.4 no
// expone un builder `.check()` en pg-core.
export const messageQueue = pgTable("message_queue", {
  id: id(),
  conversationId: uuid("conversation_id").notNull(),
  content: text("content").notNull(),
  senderType: varchar("sender_type", { length: 20 }).notNull(), // agent | system
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | sent | failed | cancelled
  retryCount: integer("retry_count").notNull().default(0),
  lastError: text("last_error"),
  externalMessageId: varchar("external_message_id", { length: 255 }),
  createdAt: createdAt(),
  processedAt: timestamp("processed_at"),
  scheduledFor: timestamp("scheduled_for"),
});

// Migración 1.21.0 (whatsapp-reliability.sql, misma migración que
// deliveryLogs/messageQueue arriba). Contador de mensajes por usuario por
// minuto — usado por rate-limiter.service.ts (Task 4) para no superar 50
// msgs/min (envíos manuales, ver POST /crm/conversations/:id/messages) ni 10
// msgs/min (automatizaciones). Un row = un minuto de actividad de un usuario;
// `checkRateLimit` hace upsert manual (select + insert/update) en vez de un
// `ON CONFLICT DO UPDATE` porque necesita leer el `count` actual antes de
// decidir si permite el envío. La PK compuesta (user_id, minute_key) vive acá
// Y en la migración SQL — a diferencia del CHECK de otras tablas (que sí solo
// vive en SQL, ver comentario en deliveryLogs), Drizzle 0.36.4 sí expone
// `primaryKey()` como segundo argumento de `pgTable`.
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    userId: uuid("user_id").notNull(),
    minuteKey: varchar("minute_key", { length: 50 }).notNull(),
    count: integer("count").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.minuteKey] }),
  }),
);
