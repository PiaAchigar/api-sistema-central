import {
  boolean,
  date,
  decimal,
  integer,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Las tablas se crearon sin DEFAULTs en Postgres (ver migrations/1.0.0/init.sql),
// por eso id/created_at/updated_at se generan en runtime con $defaultFn.
const id = () => uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at").$defaultFn(() => new Date());
const updatedAt = () =>
  timestamp("updated_at")
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());

export const categories = pgTable("categories", {
  id: id(),
  parentCategoryId: uuid("parent_category_id"),
  name: varchar("name", { length: 255 }),
  description: text("description"),
  displayOrder: integer("display_order"),
  isActive: boolean("is_active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const serviceCategory = pgTable("service_category", {
  serviceId: uuid("service_id"),
  categoryId: uuid("category_id"),
  createdAt: createdAt(),
});

export const service = pgTable("service", {
  id: id(),
  name: varchar("name", { length: 255 }),
  description: varchar("description", { length: 255 }),
  code: varchar("code", { length: 50 }),
  unitPriceList: decimal("unit_price_list", { precision: 10, scale: 2 }),
  unitPriceCash: decimal("unit_price_cash", { precision: 10, scale: 2 }),
  unitType: varchar("unit_type", { length: 50 }),
  taxCategory: varchar("tax_category", { length: 50 }),
  requiresOperator: boolean("requires_operator"),
  requiresMachine: boolean("requires_machine"),
  estimatedDurationMinutes: integer("estimated_duration_minutes"),
  isActive: boolean("is_active"),
  isVisible: boolean("is_visible"),
  webImageR2Path: varchar("web_image_r2_path", { length: 500 }),
  webSortOrder: integer("web_sort_order"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const serviceProviders = pgTable("service_providers", {
  id: id(),
  fullName: varchar("full_name", { length: 255 }),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  specialties: text("specialties"),
  hireDate: date("hire_date"),
  endDate: date("end_date"),
  status: varchar("status", { length: 50 }),
  hourlyRate: decimal("hourly_rate", { precision: 10, scale: 2 }),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const serviceProviderService = pgTable("service_provider_service", {
  id: id(),
  serviceProviderId: uuid("service_provider_id"),
  serviceId: uuid("service_id"),
  paymentType: varchar("payment_type", { length: 50 }), // per_hour | percentage | fixed_per_service
  rate: decimal("rate", { precision: 10, scale: 2 }),
  validFrom: date("valid_from"),
  validUntil: date("valid_until"),
  isActive: boolean("is_active"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const serviceProviderAvailability = pgTable(
  "service_provider_availability",
  {
    id: id(),
    serviceProviderId: uuid("service_provider_id"),
    dayOfWeek: integer("day_of_week"), // 0=domingo ... 6=sábado
    workStartTime: time("work_start_time"),
    workEndTime: time("work_end_time"),
    validFrom: date("valid_from"),
    validUntil: date("valid_until"),
    isActive: boolean("is_active"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

export const providerSaturdaySchedule = pgTable("provider_saturday_schedule", {
  id: id(),
  serviceProviderId: uuid("service_provider_id"),
  saturdayDate: date("saturday_date"),
  isWorking: boolean("is_working"),
  workStartTime: time("work_start_time"),
  workEndTime: time("work_end_time"),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const providerAvailabilityExceptions = pgTable(
  "provider_availability_exceptions",
  {
    id: id(),
    serviceProviderId: uuid("service_provider_id"),
    dateException: date("date_exception"),
    dateStart: date("date_start"),
    dateEnd: date("date_end"),
    timeOverrideStart: time("time_override_start"),
    timeOverrideEnd: time("time_override_end"),
    exceptionType: varchar("exception_type", { length: 50 }),
    reason: text("reason"),
    isWorking: boolean("is_working"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

export const machines = pgTable("machines", {
  id: id(),
  name: varchar("name", { length: 255 }),
  description: text("description"),
  equipmentType: varchar("equipment_type", { length: 100 }),
  requiresOperator: boolean("requires_operator"),
  status: varchar("status", { length: 50 }),
  quantity: integer("quantity"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const serviceMachine = pgTable("service_machine", {
  id: id(),
  serviceId: uuid("service_id"),
  machineId: uuid("machine_id"),
  notes: text("notes"),
  isPrimaryMachine: boolean("is_primary_machine"),
  createdAt: createdAt(),
});

export const serviceProviderMachine = pgTable("service_provider_machine", {
  id: id(),
  serviceProviderId: uuid("service_provider_id"),
  machineId: uuid("machine_id"),
  certifiedDate: date("certified_date"),
  proficiencyLevel: varchar("proficiency_level", { length: 50 }),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const appointments = pgTable("appointments", {
  id: id(),
  customerId: uuid("customer_id"),
  serviceProviderId: uuid("service_provider_id"),
  machineId: uuid("machine_id"),
  serviceId: uuid("service_id"),
  dealId: uuid("deal_id"),
  appointmentStart: timestamp("appointment_start"),
  appointmentEnd: timestamp("appointment_end"),
  durationMinutes: integer("duration_minutes"),
  servicePrice: decimal("service_price", { precision: 10, scale: 2 }),
  status: varchar("status", { length: 50 }), // scheduled | completed | cancelled | no_show
  // Snapshots congelados al completar el turno (no se recalculan si cambia el acuerdo)
  providerPaymentType: varchar("provider_payment_type", { length: 50 }),
  providerRate: decimal("provider_rate", { precision: 10, scale: 2 }),
  providerEarning: decimal("provider_earning", { precision: 10, scale: 2 }),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const openHours = pgTable("open_hours", {
  id: id(),
  dayOfWeek: integer("day_of_week"), // 0=domingo ... 6=sábado
  openingTime: time("opening_time"),
  closingTime: time("closing_time"),
  isOpen: boolean("is_open"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
