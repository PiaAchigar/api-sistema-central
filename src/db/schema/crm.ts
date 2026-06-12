import {
  boolean,
  date,
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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: id(),
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
