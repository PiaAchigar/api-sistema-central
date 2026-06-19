-- ==============================================================================
-- Seed de DESARROLLO. Solo para la base local de docker-compose — NUNCA correr
-- contra Supabase. Datos mínimos para probar agenda + facturador end-to-end.
-- ==============================================================================

INSERT INTO company_config (id, company_name, address, phone, whatsapp)
VALUES (gen_random_uuid(), 'PiuBella', 'Mexico 1120, El Talar', '+54 9 11 3377-5014', '5491133775014');

-- Lunes a viernes 9-20, sábado 9-18, domingo cerrado
INSERT INTO open_hours (id, day_of_week, opening_time, closing_time, is_open, created_at)
SELECT gen_random_uuid(), d, '09:00'::time, (CASE WHEN d = 6 THEN '18:00' ELSE '20:00' END)::time, true, now()
FROM generate_series(1, 6) AS d;
INSERT INTO open_hours (id, day_of_week, is_open, created_at)
VALUES (gen_random_uuid(), 0, false, now());

-- Categorías jerárquicas
INSERT INTO categories (id, name, display_order, is_active, created_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'Tratamientos Faciales', 1, true, now()),
       ('33333333-3333-3333-3333-333333333333', 'Depilación Definitiva', 2, true, now());
INSERT INTO categories (id, parent_category_id, name, display_order, is_active, created_at)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Cosmetológicos', 1, true, now());

-- Servicios
INSERT INTO service (id, name, unit_price_list, unit_price_cash, tax_category, requires_operator, requires_machine, estimated_duration_minutes, is_active, created_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'Limpieza de Cutis', 45000, 40000, 'exempt', true, false, 60, true, now()),
       ('aaaaaaaa-0000-0000-0000-000000000002', 'Lifting de Pestañas', 45000, 45000, 'exempt', true, false, 45, true, now());
INSERT INTO service_category (service_id, category_id, created_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', now()),
       ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', now());

-- Proveedoras
INSERT INTO service_providers (id, full_name, status, hourly_rate, created_at)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'Romina Suárez', 'active', 8000, now()),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'Tamara Gómez', 'active', 8000, now());

-- Acuerdos de pago: Romy 60% en lifting; Tami $9000/hora en limpieza
INSERT INTO service_provider_service (id, service_provider_id, service_id, payment_type, rate, valid_from, is_active, created_at)
VALUES (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'percentage', 60, '2026-01-01', true, now()),
       (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'per_hour', 9000, '2026-01-01', true, now());

-- Disponibilidad semanal: Romy lun-vie 9-13; Tami lun-vie 13-20
INSERT INTO service_provider_availability (id, service_provider_id, day_of_week, work_start_time, work_end_time, valid_from, is_active, created_at)
SELECT gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000001', d, '09:00', '13:00', '2026-01-01', true, now() FROM generate_series(1,5) d;
INSERT INTO service_provider_availability (id, service_provider_id, day_of_week, work_start_time, work_end_time, valid_from, is_active, created_at)
SELECT gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000002', d, '13:00', '20:00', '2026-01-01', true, now() FROM generate_series(1,5) d;

-- Sábados: Romy trabaja los próximos 8 sábados de 9 a 13
INSERT INTO provider_saturday_schedule (id, service_provider_id, saturday_date, is_working, work_start_time, work_end_time, created_at)
SELECT gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000001',
       (date_trunc('week', current_date)::date + 5 + (w * 7)), true, '09:00', '13:00', now()
FROM generate_series(0, 7) AS w;

-- Clientes
INSERT INTO contacts (id, name, phone, email, status, country, created_at)
VALUES ('cccccccc-0000-0000-0000-000000000001', 'Mariana Mansilla',  '+54 9 11 5555-1234', 'mariana@example.com',   'customer', 'AR', now()),
       ('cccccccc-0000-0000-0000-000000000002', 'Sofía Herrera',     '+54 9 11 6666-2345', 'sofia@example.com',     'customer', 'AR', now()),
       ('cccccccc-0000-0000-0000-000000000003', 'Valentina López',   '+54 9 11 7777-3456', 'valentina@example.com', 'customer', 'AR', now()),
       ('cccccccc-0000-0000-0000-000000000004', 'Carolina Benítez',  '+54 9 11 8888-4567', 'carolina@example.com',  'customer', 'AR', now());
INSERT INTO customers (id, contact_id, dni, first_purchase_date, created_at)
VALUES ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '30712325', now(), now()),
       ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', '35123456', now(), now()),
       ('dddddddd-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000003', '36234567', now(), now()),
       ('dddddddd-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000004', '37345678', now(), now());

-- ==============================================================================
-- Turnos de prueba — semana del 16 al 19 Jun 2026
-- Cubre todos los estados y turnos cruzados (misma prestadora, servicios distintos).
-- IDs fijos para reproducibilidad. Limpieza=60min, Lifting=90min.
--
-- CONVENCIÓN DE TIMESTAMPS: la API y el Worker corren en UTC (Argentina = UTC-3).
-- Los timestamps se guardan en UTC → sumar 3h a la hora local deseada.
-- Ejemplo: quiero mostrar 09:00 AR → guardar 12:00 UTC.
-- ==============================================================================

-- ── Martes 16 Jun (pasados — completed / no_show) ────────────────────────────
INSERT INTO appointments (id, customer_id, service_provider_id, service_id,
  appointment_start, appointment_end, duration_minutes,
  service_price, status, provider_payment_type, provider_rate, provider_earning, created_at, updated_at)
VALUES
  -- Romina: Limpieza con Mariana 10:00-11:00 AR (13:00-14:00 UTC)
  ('eeeeeeee-0000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '2026-06-16 13:00:00', '2026-06-16 14:00:00', 60,
   45000, 'completed', 'per_hour', 9000, 9000, now(), now()),

  -- Romina: Lifting con Valentina 11:00-12:30 AR (14:00-15:30 UTC)
  ('eeeeeeee-0000-0000-0000-000000000003',
   'dddddddd-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002',
   '2026-06-16 14:00:00', '2026-06-16 15:30:00', 90,
   45000, 'completed', 'percentage', 60, 27000, now(), now()),

  -- Tamara: Lifting con Sofía 13:00-14:30 AR (16:00-17:30 UTC)
  ('eeeeeeee-0000-0000-0000-000000000002',
   'dddddddd-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002',
   '2026-06-16 16:00:00', '2026-06-16 17:30:00', 90,
   45000, 'completed', 'percentage', 60, 27000, now(), now()),

  -- Tamara: Limpieza con Mariana 15:00-16:00 AR (18:00-19:00 UTC) → no_show
  ('eeeeeeee-0000-0000-0000-000000000004',
   'dddddddd-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '2026-06-16 18:00:00', '2026-06-16 19:00:00', 60,
   45000, 'no_show', null, null, null, now(), now());

-- ── Miércoles 17 Jun (hoy — turnos cruzados + cancelled) ─────────────────────
-- Romina: Limpieza 09:00 AR + Lifting 10:30 AR → cruzado (distinto servicio, misma prestadora)
-- Tamara: Lifting 13:00 AR + Limpieza 15:00 AR → cruzado
INSERT INTO appointments (id, customer_id, service_provider_id, service_id,
  appointment_start, appointment_end, duration_minutes,
  service_price, status, created_at, updated_at)
VALUES
  -- Romina: Limpieza con Mariana 09:00-10:00 AR (12:00-13:00 UTC)
  ('eeeeeeee-0000-0000-0000-000000000005',
   'dddddddd-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '2026-06-17 12:00:00', '2026-06-17 13:00:00', 60,
   45000, 'scheduled', now(), now()),

  -- Romina: Lifting con Sofía 10:30-12:00 AR (13:30-15:00 UTC) ← cruzado
  ('eeeeeeee-0000-0000-0000-000000000006',
   'dddddddd-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002',
   '2026-06-17 13:30:00', '2026-06-17 15:00:00', 90,
   45000, 'scheduled', now(), now()),

  -- Tamara: Lifting con Valentina 13:00-14:30 AR (16:00-17:30 UTC)
  ('eeeeeeee-0000-0000-0000-000000000007',
   'dddddddd-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002',
   '2026-06-17 16:00:00', '2026-06-17 17:30:00', 90,
   45000, 'scheduled', now(), now()),

  -- Romina: Limpieza con Carolina 14:00-15:00 AR (17:00-18:00 UTC) → cancelled
  ('eeeeeeee-0000-0000-0000-000000000009',
   'dddddddd-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '2026-06-17 17:00:00', '2026-06-17 18:00:00', 60,
   45000, 'cancelled', now(), now()),

  -- Tamara: Limpieza con Carolina 15:00-16:00 AR (18:00-19:00 UTC) ← cruzado
  ('eeeeeeee-0000-0000-0000-000000000008',
   'dddddddd-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '2026-06-17 18:00:00', '2026-06-17 19:00:00', 60,
   45000, 'scheduled', now(), now());

-- ── Jueves 18 Jun (futuro — ambas columnas ocupadas a la misma hora) ──────────
INSERT INTO appointments (id, customer_id, service_provider_id, service_id,
  appointment_start, appointment_end, duration_minutes,
  service_price, status, created_at, updated_at)
VALUES
  -- Romina: Lifting con Valentina 10:00-11:30 AR (13:00-14:30 UTC)
  ('eeeeeeee-0000-0000-0000-000000000010',
   'dddddddd-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002',
   '2026-06-18 13:00:00', '2026-06-18 14:30:00', 90,
   45000, 'scheduled', now(), now()),

  -- Tamara: Limpieza con Mariana 10:00-11:00 AR (13:00-14:00 UTC) — misma hora, ambas ocupadas
  ('eeeeeeee-0000-0000-0000-000000000011',
   'dddddddd-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   '2026-06-18 13:00:00', '2026-06-18 14:00:00', 60,
   45000, 'scheduled', now(), now());

-- ── Viernes 19 Jun (futuro) ───────────────────────────────────────────────────
INSERT INTO appointments (id, customer_id, service_provider_id, service_id,
  appointment_start, appointment_end, duration_minutes,
  service_price, status, created_at, updated_at)
VALUES
  -- Romina: Limpieza con Sofía 09:30-10:30 AR (12:30-13:30 UTC)
  ('eeeeeeee-0000-0000-0000-000000000012',
   'dddddddd-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '2026-06-19 12:30:00', '2026-06-19 13:30:00', 60,
   45000, 'scheduled', now(), now()),

  -- Tamara: Lifting con Carolina 13:00-14:30 AR (16:00-17:30 UTC)
  ('eeeeeeee-0000-0000-0000-000000000013',
   'dddddddd-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002',
   '2026-06-19 16:00:00', '2026-06-19 17:30:00', 90,
   45000, 'scheduled', now(), now());
