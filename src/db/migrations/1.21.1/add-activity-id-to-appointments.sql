-- Migration 1.21.1: Add activity_id to APPOINTMENTS
-- Consolidates both Pilates class bookings and Thermo Bike machine reservations into APPOINTMENTS
-- Eliminates need for separate activity_machines table

ALTER TABLE appointments ADD COLUMN activity_id UUID;

ALTER TABLE appointments ADD CONSTRAINT fk_appointment_activity
  FOREIGN KEY (activity_id) REFERENCES activities(id);

CREATE INDEX idx_appointments_activity_id ON appointments(activity_id);

-- Note: activity_id is nullable for backward compatibility with existing service-based appointments
-- New activity-based bookings will populate activity_id; service_id may coexist for legacy records
