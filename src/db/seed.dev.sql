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

-- Cliente existente
INSERT INTO contacts (id, name, phone, email, status, country, created_at)
VALUES ('cccccccc-0000-0000-0000-000000000001', 'Mariana Mansilla', '+54 9 11 5555-1234', 'mariana@example.com', 'customer', 'AR', now());
INSERT INTO customers (id, contact_id, dni, first_purchase_date, created_at)
VALUES ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '30712325', now(), now());
