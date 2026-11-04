-- Add a non-destructive "returning from pause" flag.
-- When a broker switches Pausa → Presente, this flag is set true.
-- Dispatch prefers brokers with returning_from_pause = false.
-- The flag is cleared when the broker is actually dispatched to a client.
-- No sorteio_order or inverse_order reordering happens on pause/return.

ALTER TABLE brokers
  ADD COLUMN IF NOT EXISTS returning_from_pause boolean NOT NULL DEFAULT false;
