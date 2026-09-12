/*
# Add sorteio (draw) infrastructure

1. Changes
- Add `sorteio_order` integer column to `brokers` — stores the position assigned during the automatic shuffle at 08:46:00. NULL means not yet drawn.
- Add `sorteio_session` text column to `queue_entries` — tags entries with the current draw session ID so we can clear only the current session on restart.
- Add `plantao_sessions` table — tracks draw sessions with start time, end time, and status.

2. Security
- RLS enabled on plantao_sessions with anon+authenticated full access (single-tenant app).
*/

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'brokers' AND column_name = 'sorteio_order') THEN
    ALTER TABLE brokers ADD COLUMN sorteio_order integer;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'queue_entries' AND column_name = 'sorteio_session') THEN
    ALTER TABLE queue_entries ADD COLUMN sorteio_session text;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS plantao_sessions (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended'))
);

ALTER TABLE plantao_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_sessions" ON plantao_sessions;
CREATE POLICY "anon_select_sessions" ON plantao_sessions FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_sessions" ON plantao_sessions;
CREATE POLICY "anon_insert_sessions" ON plantao_sessions FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_sessions" ON plantao_sessions;
CREATE POLICY "anon_update_sessions" ON plantao_sessions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_sessions" ON plantao_sessions;
CREATE POLICY "anon_delete_sessions" ON plantao_sessions FOR DELETE TO anon, authenticated USING (true);
