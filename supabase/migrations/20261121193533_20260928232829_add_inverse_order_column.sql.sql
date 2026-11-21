DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'brokers' AND column_name = 'inverse_order') THEN
    ALTER TABLE brokers ADD COLUMN inverse_order integer;
  END IF;
END $$;