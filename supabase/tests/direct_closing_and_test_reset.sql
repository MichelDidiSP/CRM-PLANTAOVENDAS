\set ON_ERROR_STOP on
BEGIN;

INSERT INTO crm_private.closing_recipients (role, whatsapp, email) VALUES
  ('gerencia', '5511999991111', 'gerencia@example.com'),
  ('diretoria', '5511999992222', 'diretoria@example.com');
SET LOCAL ROLE anon;
SELECT public.record_incorporadora_direct_lead('{"customer_name":"Direto Teste","phone":"11933334444",
  "visit_reason":"Primeira visita","media_channel":"Google","is_test":true,
  "created_at":"2045-03-12T08:00:00-03:00","shift":"manha"}');
SELECT public.record_partner_reception(
  '{"id":"50000000-0000-0000-0000-000000000011","partner_name":"Parceiro","company":"Externa","creci":"123",
    "client_first_name":"Cliente","arrival":"accompanied","manager_target":"partnerships","created_at":"2045-03-12T08:00:00-03:00"}',
  '{"customer_name":"Cliente Parceiro","phone":"11944445555","media_channel":"Google"}');
UPDATE public.external_partner_intakes SET manager_status = 'acknowledged'
  WHERE id = '50000000-0000-0000-0000-000000000011';
SELECT public.reserve_partner_unit('50000000-0000-0000-0000-000000000011', '101');
INSERT INTO public.brokers (id, operational_name, agency, equipe, presence_status, attendance_status, shift, arrived_at) VALUES
  ('10000000-0000-0000-0000-000000000021', 'He-Man', 'Casa Nobre', 'Original', 'presente', 'livre', 'manha', '2045-03-12T08:10:00-03:00');
INSERT INTO public.visits (id, customer_name, phone, visit_reason, media_channel, is_test, created_at) VALUES
  ('20000000-0000-0000-0000-000000000021', 'Cliente Teste', '11911112222', 'Retorno', 'Google', true, '2045-03-12T08:20:00-03:00'),
  ('20000000-0000-0000-0000-000000000022', 'Historico', '11922223333', 'Primeira visita', 'Google', true, '2045-03-11T08:20:00-03:00'),
  ('20000000-0000-0000-0000-000000000023', 'Cadastro Real', '11955556666', 'Primeira visita', 'Google', false, '2045-03-12T08:20:00-03:00');
INSERT INTO public.queue_entries (id, visit_id, broker_id, queue_type, queue_status, agency, shift, created_at) VALUES
  ('30000000-0000-0000-0000-000000000021', '20000000-0000-0000-0000-000000000021', '10000000-0000-0000-0000-000000000021',
    'geral', 'concluido', 'Casa Nobre', 'manha', '2045-03-12T08:20:00-03:00'),
  ('30000000-0000-0000-0000-000000000022', '20000000-0000-0000-0000-000000000022', '10000000-0000-0000-0000-000000000021',
    'geral', 'concluido', 'Casa Nobre', 'manha', '2045-03-11T08:20:00-03:00');
INSERT INTO public.pause_audit (id, broker_id, event, scope, pause_started_at, occurred_at) VALUES
  ('reset-today', '10000000-0000-0000-0000-000000000021', 'evasion', '2045-03-12:manha', '2045-03-12T08:00:00-03:00', '2045-03-12T10:01:00-03:00'),
  ('reset-old', '10000000-0000-0000-0000-000000000021', 'evasion', '2045-03-11:manha', '2045-03-11T08:00:00-03:00', '2045-03-11T10:01:00-03:00');
INSERT INTO public.plantao_sessions (id, plantao_date, status, shift) VALUES
  ('reset-today', '2045-03-12', 'active', 'manha'), ('reset-old', '2045-03-11', 'ended', 'manha');
RESET ROLE;
INSERT INTO crm_private.plantao_daily_closures (date, closed_by, report_rows, customers)
  VALUES ('2045-03-11', 'historico', '[]', '[]');
CREATE TEMP TABLE reset_expected_facts AS SELECT * FROM public.quantitative_attendance_facts;
CREATE TEMP TABLE reset_expected_brokers AS SELECT id, operational_name, agency, equipe FROM public.brokers;

SET LOCAL ROLE anon;
DO $$
DECLARE summary jsonb;
BEGIN
  IF nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN RAISE EXCEPTION 'O teste deve rodar sem operador autenticado.'; END IF;
  summary := public.close_plantao_operation('2045-03-12', '2045-03-12T19:00:00-03:00');
  IF NOT public.is_plantao_closed('2045-03-12') OR
    (SELECT sum((r->>'count')::integer) FROM jsonb_array_elements(summary->'rows') r) <> 3
    OR jsonb_array_length(summary->'recipients') <> 2 THEN
    RAISE EXCEPTION 'Fechamento direto ou destinatários incompletos: %', summary;
  END IF;
  IF summary::text ~ '11911112222|11933334444|11944445555|Cliente Teste' THEN
    RAISE EXCEPTION 'O resumo público expôs o snapshot nominal.';
  END IF;
  IF public.close_plantao_operation('2045-03-12', '2045-03-12T20:00:00-03:00') <> summary THEN
    RAISE EXCEPTION 'O snapshot definitivo foi refeito.';
  END IF;
  BEGIN
    PERFORM public.reset_test_plantao('2045-03-12', false, '2045-03-12T19:00:00-03:00');
    RAISE EXCEPTION 'Reset aceito sem intenção explícita de TESTE.';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Ative o módulo TESTE para reiniciar o plantão.' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crm_private.plantao_daily_closures WHERE date = '2045-03-12'
    AND closed_by = 'operacao_stand' AND closed_at = '2045-03-12T19:00:00-03:00'
    AND customers @> '[{"name":"Cliente Teste","phone":"11911112222","broker":"He-Man","media":"Google","type":"Retorno"}]'
    AND customers @> '[{"name":"Direto Teste","phone":"11933334444"}]') THEN
    RAISE EXCEPTION 'Snapshot nominal ou identificador da operação ausente.';
  END IF;
END $$;

-- A failure after queue deletion must roll back the whole reset, including reopening.
CREATE FUNCTION pg_temp.fail_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Falha de reset simulada'; END $$;
CREATE TRIGGER simulate_reset_failure BEFORE DELETE ON public.pause_audit
  FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_reset();
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.reset_test_plantao('2045-03-12', true, '2045-03-12T19:00:00-03:00');
    RAISE EXCEPTION 'A falha simulada não interrompeu a transação.';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Falha de reset simulada' THEN RAISE; END IF;
  END;
  IF NOT public.is_plantao_closed('2045-03-12') OR NOT EXISTS
    (SELECT 1 FROM public.queue_entries WHERE id = '30000000-0000-0000-0000-000000000021') THEN
    RAISE EXCEPTION 'A falha deixou o reset parcialmente aplicado.';
  END IF;
END $$;
RESET ROLE;
DROP TRIGGER simulate_reset_failure ON public.pause_audit;
SET LOCAL ROLE anon;
SELECT public.reset_test_plantao('2045-03-12', true, '2045-03-12T19:00:00-03:00');
SELECT public.reset_test_plantao('2045-03-12', true, '2045-03-12T19:00:00-03:00');
RESET ROLE;
DO $$
BEGIN
  IF public.is_plantao_closed('2045-03-12') OR NOT public.is_plantao_closed('2045-03-11') THEN
    RAISE EXCEPTION 'O reset não ficou limitado ao fechamento do dia escolhido.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.queue_entries WHERE id = '30000000-0000-0000-0000-000000000021')
    OR EXISTS (SELECT 1 FROM public.visits WHERE id = '20000000-0000-0000-0000-000000000021')
    OR EXISTS (SELECT 1 FROM crm_private.incorporadora_direct_leads WHERE is_test)
    OR EXISTS (SELECT 1 FROM public.plantao_sessions WHERE plantao_date = '2045-03-12')
    OR EXISTS (SELECT 1 FROM public.pause_audit WHERE id = 'reset-today')
    OR EXISTS (SELECT 1 FROM public.external_partner_intakes WHERE id = '50000000-0000-0000-0000-000000000011')
    OR EXISTS (SELECT 1 FROM public.external_partner_reservations WHERE intake_id = '50000000-0000-0000-0000-000000000011')
    OR EXISTS (SELECT 1 FROM crm_private.partner_reception_details WHERE intake_id = '50000000-0000-0000-0000-000000000011') THEN
    RAISE EXCEPTION 'Restaram registros operacionais do dia.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.visits WHERE id = '20000000-0000-0000-0000-000000000022')
    OR NOT EXISTS (SELECT 1 FROM public.queue_entries WHERE id = '30000000-0000-0000-0000-000000000022')
    OR NOT EXISTS (SELECT 1 FROM public.pause_audit WHERE id = 'reset-old')
    OR NOT EXISTS (SELECT 1 FROM public.plantao_sessions WHERE id = 'reset-old')
    OR NOT EXISTS (SELECT 1 FROM public.visits WHERE id = '20000000-0000-0000-0000-000000000023' AND status = 'encerrado') THEN
    RAISE EXCEPTION 'Histórico de outro dia ou cadastro real foi removido.';
  END IF;
  IF EXISTS ((SELECT * FROM public.quantitative_attendance_facts EXCEPT SELECT * FROM reset_expected_facts)
    UNION ALL (SELECT * FROM reset_expected_facts EXCEPT SELECT * FROM public.quantitative_attendance_facts)) THEN
    RAISE EXCEPTION 'Fatos quantitativos foram alterados.';
  END IF;
  IF EXISTS ((SELECT id, operational_name, agency, equipe FROM public.brokers EXCEPT SELECT * FROM reset_expected_brokers)
    UNION ALL (SELECT * FROM reset_expected_brokers EXCEPT SELECT id, operational_name, agency, equipe FROM public.brokers))
    OR EXISTS (SELECT 1 FROM public.brokers WHERE presence_status <> 'ausente' OR attendance_status <> 'livre'
      OR pause_started_at IS NOT NULL OR only_own_referrals OR sorteio_order IS NOT NULL) THEN
    RAISE EXCEPTION 'Cadastros dos corretores alterados ou status não reiniciados.';
  END IF;
END $$;
ROLLBACK;
