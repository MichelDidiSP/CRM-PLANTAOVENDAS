/*
# Add inverse_order column for independent inverse queue numbering

1. New Column
- brokers.inverse_order integer — stores the position of this broker in the
  Fila Inversa Geral, assigned at sorteio time as the mirror of the direct
  queue (last in direct = first in inverse). After sorteio the two queues
  are completely decoupled: each has its own 1, 2, 3... sequence and late
  check-ins are .push()ed to the end of each independently.

2. Notes
- Nullable; NULL means the broker has not been drawn yet.
- No constraint changes needed.
- Idempotent.
*/

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'brokers' AND column_name = 'inverse_order') THEN
    ALTER TABLE brokers ADD COLUMN inverse_order integer;
  END IF;
END $$;
