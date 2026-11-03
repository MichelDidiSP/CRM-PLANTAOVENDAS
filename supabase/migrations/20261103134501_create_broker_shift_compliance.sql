/*
# Create broker_shift_compliance log

1. New table: `broker_shift_compliance`
- `id` (uuid, primary key)
- `broker_id` (uuid, not null): the broker. Intentionally NOT a foreign key so the history survives if a broker record is removed.
- `broker_name` (text, not null), `agency` (text, not null)
- `plantao_date` (date, not null): the plantão day of the event
- `shift` (text, not null): 'manha' or 'tarde'
- `arrived_at` (timestamptz): check-in time
- `left_at` (timestamptz, not null): moment the broker switched to Ausente or Pausa
- `active_minutes` (integer, not null): minutes between check-in and departure
- `returned_at` (timestamptz, nullable): set if the broker later returned to Presente. Rows with null here are abandonments.
- `created_at` (timestamptz, default now())

2. Security
- RLS enabled. The app has no sign-in, so policies allow anon and authenticated.
- Grants: SELECT, INSERT, UPDATE only. No DELETE, so the log cannot be erased from the app.

3. Notes
- Idempotent: safe to re-run.
*/

CREATE TABLE IF NOT EXISTS broker_shift_compliance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id uuid NOT NULL,
  broker_name text NOT NULL,
  agency text NOT NULL,
  plantao_date date NOT NULL,
  shift text NOT NULL CHECK (shift IN ('manha', 'tarde')),
  arrived_at timestamptz,
  left_at timestamptz NOT NULL,
  active_minutes integer NOT NULL DEFAULT 0,
  returned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_shift_compliance_date_shift_idx ON broker_shift_compliance (plantao_date, shift);
CREATE INDEX IF NOT EXISTS broker_shift_compliance_broker_idx ON broker_shift_compliance (broker_id);

ALTER TABLE broker_shift_compliance ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON broker_shift_compliance TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_broker_shift_compliance" ON broker_shift_compliance;
CREATE POLICY "anon_select_broker_shift_compliance" ON broker_shift_compliance FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_broker_shift_compliance" ON broker_shift_compliance;
CREATE POLICY "anon_insert_broker_shift_compliance" ON broker_shift_compliance FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_broker_shift_compliance" ON broker_shift_compliance;
CREATE POLICY "anon_update_broker_shift_compliance" ON broker_shift_compliance FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
