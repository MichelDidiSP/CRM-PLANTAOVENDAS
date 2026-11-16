\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id) VALUES ('40000000-0000-0000-0000-000000000001');
INSERT INTO crm_private.closing_operators VALUES ('40000000-0000-0000-0000-000000000001', 'gerencia');
INSERT INTO crm_private.closing_recipients (role, whatsapp) VALUES ('diretoria', '5511999999999');

SET LOCAL ROLE anon;
SELECT public.record_incorporadora_direct_lead(
  '{"customer_name":"Cliente da incorporadora","phone":"(11) 91234-5678","visit_reason":"Primeira visita",
    "media_channel":"Google / Pesquisa","created_at":"2040-01-20T10:00:00-03:00","shift":"manha"}'
);
DO $$
BEGIN
  IF has_schema_privilege(current_user, 'crm_private', 'USAGE') OR
    has_function_privilege(current_user, 'public.close_plantao_day(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'O acesso anônimo alcançou o fechamento privativo.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.quantitative_report_rows('2040-01-20', '2040-01-20', NULL)
    WHERE company = 'Incorporadora' AND total = 1) THEN
    RAISE EXCEPTION 'O lead direto não foi contado.';
  END IF;
END $$;
RESET ROLE;

INSERT INTO public.brokers (id, operational_name, agency, equipe, presence_status, attendance_status, shift, arrived_at) VALUES
  ('10000000-0000-0000-0000-000000000001', 'Original', 'Viva Imóveis', 'A', 'ausente', 'livre', 'manha', NULL),
  ('10000000-0000-0000-0000-000000000002', 'Efetivo', 'Casa Nobre', 'B', 'presente', 'livre', 'manha', '2040-01-20T08:40:00-03:00'),
  ('10000000-0000-0000-0000-000000000003', 'Pausado', 'Casa Nobre', 'B', 'pausa', 'livre', 'manha', '2040-01-20T08:40:00-03:00');
INSERT INTO public.visits (id, customer_name, phone, visit_reason, referred_broker_id, created_at) VALUES
  ('20000000-0000-0000-0000-000000000001', 'Cliente atendido', '11987654321', 'Retorno',
   '10000000-0000-0000-0000-000000000001', '2040-01-20T11:00:00-03:00');
INSERT INTO public.queue_entries (id, visit_id, agency, queue_type, shift, reception_waiting, created_at) VALUES
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
   'Viva Imóveis', 'geral', 'manha', true, '2040-01-20T11:00:00-03:00');

SET LOCAL ROLE anon;
DO $$
BEGIN
  IF public.claim_reception_call('30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000003', true, '2040-01-20T11:01:00-03:00') THEN
    RAISE EXCEPTION 'Corretor em pausa recebeu chamada.';
  END IF;
  IF NOT public.claim_reception_call('30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000002', true, '2040-01-20T11:01:00-03:00') THEN
    RAISE EXCEPTION 'A chamada com split não foi registrada.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.queue_entries WHERE commission_split
    AND applied_rule = 'Transbordo Interempresas (Split)' AND queue_status = 'chamando') THEN
    RAISE EXCEPTION 'Regra aplicada ausente no histórico.';
  END IF;
END $$;
RESET ROLE;
UPDATE public.queue_entries SET queue_status = 'em_atendimento' WHERE queue_status = 'chamando';
UPDATE public.visits SET status = 'em_atendimento' WHERE id = '20000000-0000-0000-0000-000000000001';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);
DO $$
DECLARE summary jsonb;
BEGIN
  summary := public.close_plantao_day('2040-01-20');
  IF summary::text ~ '11912345678|11987654321' OR jsonb_array_length(summary->'recipients') <> 1
    OR (SELECT sum((r->>'count')::integer) FROM jsonb_array_elements(summary->'rows') r) <> 2 THEN
    RAISE EXCEPTION 'Resumo incorreto ou contém dados pessoais: %', summary;
  END IF;
  IF NOT public.is_plantao_closed('2040-01-20') OR public.close_plantao_day('2040-01-20') <> summary THEN
    RAISE EXCEPTION 'Fechamento não foi gravado de forma idempotente.';
  END IF;
  BEGIN
    INSERT INTO public.visits (customer_name, phone, visit_reason, created_at)
    VALUES ('Cadastro bloqueado', '11999990000', 'Primeira visita', '2040-01-20T12:00:00-03:00');
    RAISE EXCEPTION 'Cadastro aceito após fechamento.';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Plantão encerrado para esta data.' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crm_private.incorporadora_direct_leads WHERE phone = '11912345678') OR
    NOT EXISTS (SELECT 1 FROM crm_private.plantao_daily_closures
      WHERE customers @> '[{"name":"Cliente atendido","phone":"11987654321","broker":"Efetivo","commission_split":true}]') THEN
    RAISE EXCEPTION 'Cadastro nominal não foi preservado.';
  END IF;
END $$;
ROLLBACK;
