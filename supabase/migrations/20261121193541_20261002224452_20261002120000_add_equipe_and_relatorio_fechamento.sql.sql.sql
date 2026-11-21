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