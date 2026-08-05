-- Migration 1.21.2: Fix TRAINING_SUBSCRIPTIONS to reference ACTIVITIES instead of TRAINING
-- TRAINING_SUBSCRIPTIONS was incorrectly designed for professional trainings
-- It should reference client subscription activities (ACTIVITIES table) instead

-- Drop the old foreign key constraint
ALTER TABLE training_subscriptions DROP CONSTRAINT IF EXISTS fk_training_subscriptions_training_id;

-- Rename training_id to activity_id
ALTER TABLE training_subscriptions RENAME COLUMN training_id TO activity_id;

-- Create new foreign key to ACTIVITIES
ALTER TABLE training_subscriptions ADD CONSTRAINT fk_training_subscriptions_activity_id
  FOREIGN KEY (activity_id) REFERENCES activities(id);

-- Recreate index with new name for clarity
DROP INDEX IF EXISTS idx_training_subscriptions_training_id;
CREATE INDEX idx_training_subscriptions_activity_id ON training_subscriptions(activity_id);
