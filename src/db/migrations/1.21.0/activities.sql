-- Migration 1.21.0: Create ACTIVITIES, ACTIVITY_SCHEDULES, and ACTIVITY_ATTENDANCE tables
-- This separates client subscription activities (Pilates, Thermo Bike) from professional trainings

-- ACTIVITIES: Recurring activities offered to end-clients (not professional trainings)
-- Different from TRAINING: activities have indefinite duration until client cancellation
CREATE TABLE activities (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  activity_type VARCHAR(50) NOT NULL, -- 'class' or 'machine'
  service_provider_id UUID, -- Nullable for machine-based activities
  classes_per_month INTEGER NOT NULL DEFAULT 0, -- Hard limit for class-based activities; 0 for machine-based
  monthly_base_price DECIMAL(10, 2) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_activity_provider
    FOREIGN KEY (service_provider_id) REFERENCES service_providers(id)
);

CREATE INDEX idx_activities_provider_id ON activities(service_provider_id);
CREATE INDEX idx_activities_type ON activities(activity_type);
CREATE INDEX idx_activities_is_active ON activities(is_active);

-- ACTIVITY_SCHEDULES: Time slots when activities can be booked
-- Supports recurring weekly schedules with optional machine assignment
CREATE TABLE activity_schedules (
  id UUID PRIMARY KEY,
  activity_id UUID NOT NULL,
  machine_id UUID, -- Nullable; only relevant for machine-based activities
  day_of_week INTEGER NOT NULL, -- 0=Sunday, 1=Monday, ..., 6=Saturday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  valid_from DATE,
  valid_until DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_schedule_activity
    FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
  CONSTRAINT fk_schedule_machine
    FOREIGN KEY (machine_id) REFERENCES machines(id)
);

CREATE INDEX idx_activity_schedules_activity_id ON activity_schedules(activity_id);
CREATE INDEX idx_activity_schedules_machine_id ON activity_schedules(machine_id);
CREATE INDEX idx_activity_schedules_day_of_week ON activity_schedules(day_of_week);

-- ACTIVITY_ATTENDANCE: Track which classes clients attended and decrement monthly quota
-- Links subscription to actual attendance; used to enforce classes_per_month hard limit
CREATE TABLE activity_attendance (
  id UUID PRIMARY KEY,
  subscription_id UUID NOT NULL,
  activity_id UUID NOT NULL,
  class_date DATE NOT NULL,
  attended BOOLEAN DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_attendance_subscription
    FOREIGN KEY (subscription_id) REFERENCES training_subscriptions(id) ON DELETE CASCADE,
  CONSTRAINT fk_attendance_activity
    FOREIGN KEY (activity_id) REFERENCES activities(id)
);

CREATE INDEX idx_activity_attendance_subscription_id ON activity_attendance(subscription_id);
CREATE INDEX idx_activity_attendance_activity_id ON activity_attendance(activity_id);
CREATE INDEX idx_activity_attendance_class_date ON activity_attendance(class_date);
CREATE INDEX idx_activity_attendance_attended ON activity_attendance(attended);
