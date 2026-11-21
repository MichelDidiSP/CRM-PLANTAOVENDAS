ALTER TABLE brokers
  ADD COLUMN IF NOT EXISTS returning_from_pause boolean NOT NULL DEFAULT false;