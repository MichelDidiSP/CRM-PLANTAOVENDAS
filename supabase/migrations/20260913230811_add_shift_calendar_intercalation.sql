/*
# Add shift, calendar, and infinite intercalation infrastructure

1. New Columns
- brokers.shift text ('manha' | 'tarde') — tracks which shift a broker checked in for
- brokers.afternoon_reserved boolean default false — marks brokers still in attendance at 14:00 who get a reserved afternoon slot
- queue_entries.shift text ('manha' | 'tarde') — tags entries with the shift they belong to
- plantao_sessions.shift text — which shift the session belongs to
- plantao_sessions.plantao_date date — the date of the plantão
- plantao_sessions.last_called_agency text — tracks whose turn it is in the intercalation

2. Missing Columns (safety check — added if previous MCP migrations were lost)
- brokers.is_external_partner, brokers.external_company, brokers.sorteio_order
- queue_entries.queue_type, queue_entries.sorteio_session, queue_entries.reentry_at
- visits.updated_at

3. Constraint Fixes
- brokers.agency: add 'Externo' for partner brokers
- brokers.attendance_status: add 'parceiro' for partner brokers
- visits.visit_reason: change 'Decorado' to 'Visita ao Decorado'
- queue_entries.agency: add 'Externo' for parceria entries

4. Security
- No RLS changes; existing policies remain valid.

5. Notes
- All additions are nullable/defaulted to preserve existing data.
- Idempotent: safe to re-run.
*/

-- ===== Missing columns from prior MCP migrations (safety net) =====

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'brokers' AND column_name = 'is_external_partner') THEN
    ALTER TABLE brokers ADD COLUMN is_external_partner boolean NOT NULL DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'brokers' AND column_name = 'external_company') THEN
    ALTER TABLE brokers ADD COLUMN external_company text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'brokers' AND column_name = 'sorteio_order') THEN
    ALTER TABLE brokers ADD COLUMN sorteio_order integer;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'queue_entries' AND column_name = 'queue_type') THEN
    ALTER TABLE queue_entries ADD COLUMN queue_type text NOT NULL DEFAULT 'geral';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'queue_entries' AND column_name = 'sorteio_session') THEN
    ALTER TABLE queue_entries ADD COLUMN sorteio_session text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'queue_entries' AND column_name = 'reentry_at') THEN
    ALTER TABLE queue_entries ADD COLUMN reentry_at timestamptz;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visits' AND column_name = 'updated_at') THEN
    ALTER TABLE visits ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  END IF;
END $$;

-- ===== Constraint fixes =====

ALTER TABLE brokers DROP CONSTRAINT IF EXISTS brokers_agency_check;
ALTER TABLE brokers ADD CONSTRAINT brokers_agency_check CHECK (agency IN ('Viva Imóveis', 'Casa Nobre', 'Externo'));

ALTER TABLE brokers DROP CONSTRAINT IF EXISTS brokers_attendance_status_check;
ALTER TABLE brokers ADD CONSTRAINT brokers_attendance_status_check CHECK (attendance_status IN ('livre', 'em_mesa', 'decorado', 'encerrado', 'parceiro'));

UPDATE visits SET visit_reason = 'Visita ao Decorado' WHERE visit_reason = 'Decorado';
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_visit_reason_check;
ALTER TABLE visits ADD CONSTRAINT visits_visit_reason_check CHECK (visit_reason IN ('Primeira visita', 'Retorno', 'Indicação', 'Parceria', 'Visita ao Decorado'));

ALTER TABLE queue_entries DROP CONSTRAINT IF EXISTS queue_entries_agency_check;
ALTER TABLE queue_entries ADD CONSTRAINT queue_entries_agency_check CHECK (agency IN ('Viva Imóveis', 'Casa Nobre', 'Externo'));

-- ===== New columns for shift / calendar / intercalation =====

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'brokers' AND column_name = 'shift') THEN
    ALTER TABLE brokers ADD COLUMN shift text CHECK (shift IN ('manha', 'tarde'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'brokers' AND column_name = 'afternoon_reserved') THEN
    ALTER TABLE brokers ADD COLUMN afternoon_reserved boolean NOT NULL DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'queue_entries' AND column_name = 'shift') THEN
    ALTER TABLE queue_entries ADD COLUMN shift text CHECK (shift IN ('manha', 'tarde'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'plantao_sessions' AND column_name = 'shift') THEN
    ALTER TABLE plantao_sessions ADD COLUMN shift text CHECK (shift IN ('manha', 'tarde'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'plantao_sessions' AND column_name = 'plantao_date') THEN
    ALTER TABLE plantao_sessions ADD COLUMN plantao_date date;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'plantao_sessions' AND column_name = 'last_called_agency') THEN
    ALTER TABLE plantao_sessions ADD COLUMN last_called_agency text;
  END IF;
END $$;

-- Ensure plantao_sessions table exists (safety net)
CREATE TABLE IF NOT EXISTS plantao_sessions (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  shift text CHECK (shift IN ('manha', 'tarde')),
  plantao_date date,
  last_called_agency text
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