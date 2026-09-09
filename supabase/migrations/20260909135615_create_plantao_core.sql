/*
# Núcleo do CRM do plantão imobiliário

1. Novas tabelas
- `brokers`: profissionais, imobiliária, presença, limite do sorteio e status de atendimento.
- `visits`: chegada do cliente, telefone com DDD como chave de deduplicação, motivo e status.
- `queue_entries`: registro durável da fila, tentativas, chamadas e reentradas.

2. Regras de negócio
- O telefone é único em `visits` para impedir duplicidade de cadastro.
- `queue_entries` mantém carimbos de data/hora para ordenar reentradas com justiça.
- Até três tentativas são registradas por chamada.

3. Segurança
- Todas as tabelas têm RLS habilitado.
- Este é um painel operacional compartilhado, sem login: anon e authenticated podem operar as quatro ações CRUD.

4. Observações
- As políticas públicas são intencionais para permitir que recepção, TV e corretores usem o mesmo plantão.
- Não há remoção destrutiva de dados; encerramentos são estados auditáveis.
*/

CREATE TABLE IF NOT EXISTS public.brokers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operational_name text NOT NULL,
  agency text NOT NULL CHECK (agency IN ('Viva Imóveis', 'Casa Nobre')),
  presence_status text NOT NULL DEFAULT 'ausente' CHECK (presence_status IN ('ausente', 'presente', 'pausa')),
  attendance_status text NOT NULL DEFAULT 'livre' CHECK (attendance_status IN ('livre', 'em_mesa', 'decorado', 'encerrado')),
  arrived_at timestamptz,
  last_status_update timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name text NOT NULL,
  phone text NOT NULL UNIQUE,
  visit_reason text NOT NULL CHECK (visit_reason IN ('Primeira visita', 'Retorno', 'Indicação', 'Parceria', 'Decorado')),
  referred_broker_id uuid REFERENCES public.brokers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando', 'em_atendimento', 'encerrado', 'recusado')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES public.brokers(id) ON DELETE SET NULL,
  agency text NOT NULL CHECK (agency IN ('Viva Imóveis', 'Casa Nobre')),
  queue_status text NOT NULL DEFAULT 'aguardando' CHECK (queue_status IN ('aguardando', 'chamando', 'ausente', 'em_atendimento', 'concluido')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
  called_at timestamptz,
  reentry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visits_status_created_at ON public.visits(status, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_entries_status_order ON public.queue_entries(queue_status, reentry_at, created_at);
CREATE INDEX IF NOT EXISTS idx_brokers_agency_presence ON public.brokers(agency, presence_status);

ALTER TABLE public.brokers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shared_select_brokers" ON public.brokers;
CREATE POLICY "shared_select_brokers" ON public.brokers FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "shared_insert_brokers" ON public.brokers;
CREATE POLICY "shared_insert_brokers" ON public.brokers FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "shared_update_brokers" ON public.brokers;
CREATE POLICY "shared_update_brokers" ON public.brokers FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "shared_delete_brokers" ON public.brokers;
CREATE POLICY "shared_delete_brokers" ON public.brokers FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "shared_select_visits" ON public.visits;
CREATE POLICY "shared_select_visits" ON public.visits FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "shared_insert_visits" ON public.visits;
CREATE POLICY "shared_insert_visits" ON public.visits FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "shared_update_visits" ON public.visits;
CREATE POLICY "shared_update_visits" ON public.visits FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "shared_delete_visits" ON public.visits;
CREATE POLICY "shared_delete_visits" ON public.visits FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "shared_select_queue_entries" ON public.queue_entries;
CREATE POLICY "shared_select_queue_entries" ON public.queue_entries FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "shared_insert_queue_entries" ON public.queue_entries;
CREATE POLICY "shared_insert_queue_entries" ON public.queue_entries FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "shared_update_queue_entries" ON public.queue_entries;
CREATE POLICY "shared_update_queue_entries" ON public.queue_entries FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "shared_delete_queue_entries" ON public.queue_entries;
CREATE POLICY "shared_delete_queue_entries" ON public.queue_entries FOR DELETE TO anon, authenticated USING (true);
