/*
# Add equipe (team) column and relatorio_fechamento table

## 1. Modified Tables
- `brokers`: adds `equipe` (text, NOT NULL DEFAULT 'Sem Equipe') — the team manager's name.
  This groups brokers into teams within each company (Agency). Teams 1 and 2 have
  4 brokers each for physical check-in; Team 3 ("Externa A/B") stays "ausente" by
  default to simulate external broker indications.

## 2. New Tables
- `relatorio_fechamento`: attendance log snapshot exported at shift transitions (14:00h).
  - `id` (uuid PK)
  - `shift` (text: 'manha' | 'tarde')
  - `snapshot_data` (jsonb — serialized attendance entries)
  - `total_attendances` (int)
  - `created_at` (timestamptz)

## 3. Security
- RLS enabled on `relatorio_fechamento`.
- anon + authenticated CRUD (single-tenant, no-auth app — data is intentionally shared).
*/

ALTER TABLE brokers ADD COLUMN IF NOT EXISTS equipe text NOT NULL DEFAULT 'Sem Equipe';

CREATE TABLE IF NOT EXISTS relatorio_fechamento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift text NOT NULL,
  snapshot_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_attendances integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE relatorio_fechamento ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_relatorio_fechamento" ON relatorio_fechamento;
CREATE POLICY "anon_select_relatorio_fechamento" ON relatorio_fechamento FOR SELECT
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_relatorio_fechamento" ON relatorio_fechamento;
CREATE POLICY "anon_insert_relatorio_fechamento" ON relatorio_fechamento FOR INSERT
TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_relatorio_fechamento" ON relatorio_fechamento;
CREATE POLICY "anon_update_relatorio_fechamento" ON relatorio_fechamento FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_relatorio_fechamento" ON relatorio_fechamento;
CREATE POLICY "anon_delete_relatorio_fechamento" ON relatorio_fechamento FOR DELETE
TO anon, authenticated USING (true);
