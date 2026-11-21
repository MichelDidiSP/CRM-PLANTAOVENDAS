\set ON_ERROR_STOP on
BEGIN;
-- This file runs with the real pg-safeupdate extension, like every other database test.
INSERT INTO crm_private.closing_recipients(role,whatsapp,email) VALUES('gerencia','5511999999999','gerencia@example.com');
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF public.close_plantao_automatically('2046-01-23','2046-01-23T20:59:59-03:00') IS NOT NULL THEN RAISE EXCEPTION 'Fechou antes das 21h'; END IF;
END $$;
SELECT public.set_plantao_day_extension('2046-01-23',true,'2046-01-23T20:55:00-03:00');
SELECT public.set_plantao_day_extension('2046-01-23',true,'2046-01-23T20:56:00-03:00');
DO $$
BEGIN
  IF public.close_plantao_automatically('2046-01-23','2046-01-23T21:00:00-03:00') IS NOT NULL
    OR public.close_plantao_automatically('2046-01-23','2046-01-23T23:59:59-03:00') IS NOT NULL
    OR public.is_plantao_closed('2046-01-23') THEN RAISE EXCEPTION 'Ignorou extensão'; END IF;
END $$;
-- New direct appointments also persist optional metadata and quantitative category.
SELECT public.record_incorporadora_direct_lead('{"customer_name":"Agendado Direto","phone":"11912345678",
 "visit_reason":"Atendimento Agendado","scheduled_time":"22:30","shift":"tarde","is_test":true,"created_at":"2046-01-23T22:00:00-03:00"}');
INSERT INTO public.brokers(id,operational_name,agency,equipe,presence_status,attendance_status,shift,arrived_at,sorteio_order,inverse_order) VALUES
 ('10000000-0000-0000-0000-000000000081','He-Man','Casa Nobre','Original','presente','livre','tarde','2046-01-23T13:10:00-03:00',1,2),
 ('10000000-0000-0000-0000-000000000082','Didi','Viva Imóveis','Original','presente','livre','tarde','2046-01-23T13:10:00-03:00',2,1);
INSERT INTO public.visits(id,customer_name,phone,visit_reason,scheduled_time,designated_broker_id,is_test,created_at) VALUES
 ('20000000-0000-0000-0000-000000000081','Agendado Atendido','11988887777','Atendimento Agendado','22:15','10000000-0000-0000-0000-000000000081',true,'2046-01-23T22:00:00-03:00');
INSERT INTO public.queue_entries(id,visit_id,queue_type,queue_status,agency,shift,created_at) VALUES
 ('30000000-0000-0000-0000-000000000081','20000000-0000-0000-0000-000000000081','geral','aguardando','Casa Nobre','tarde','2046-01-23T22:00:00-03:00');
DO $$
BEGIN
 IF NOT public.claim_reception_call('30000000-0000-0000-0000-000000000081','10000000-0000-0000-0000-000000000081',false,'2046-01-23T22:01:00-03:00',true)
 THEN RAISE EXCEPTION 'Agendado não foi chamado após 21h'; END IF;
END $$;
UPDATE public.queue_entries SET queue_status='em_atendimento',updated_at='2046-01-23T22:02:00-03:00' WHERE id='30000000-0000-0000-0000-000000000081';
UPDATE public.brokers SET attendance_status='em_atendimento' WHERE id='10000000-0000-0000-0000-000000000081';
SELECT public.conclude_queue_attendance('30000000-0000-0000-0000-000000000081','2046-01-23T22:10:00-03:00');
SELECT public.conclude_queue_attendance('30000000-0000-0000-0000-000000000081','2046-01-23T22:11:00-03:00');
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.brokers WHERE id='10000000-0000-0000-0000-000000000081'
  AND sorteio_order=floor(extract(epoch FROM TIMESTAMPTZ '2046-01-23T22:10:00-03:00')*1000) AND inverse_order=2 AND attendance_status='livre')
  OR NOT EXISTS(SELECT 1 FROM public.brokers WHERE id='10000000-0000-0000-0000-000000000082' AND sorteio_order=2 AND inverse_order=1)
  THEN RAISE EXCEPTION 'Consumo da vez duplicado ou inversa alterada'; END IF;
 IF (SELECT sum(total) FROM public.quantitative_report_rows('2046-01-23','2046-01-23',NULL) WHERE attendance_type='Atendimento Agendado')<>2
  THEN RAISE EXCEPTION 'Categoria agendado ausente ou duplicada'; END IF;
END $$;
-- Reception indicators only start with valid attendance; original owner is credited in Fifty.
INSERT INTO public.visits(id,customer_name,phone,visit_reason,referred_broker_id,is_test,created_at) VALUES
 ('20000000-0000-0000-0000-000000000082','Retorno','11922223333','Retorno','10000000-0000-0000-0000-000000000081',false,'2046-01-23T22:12:00-03:00'),
 ('20000000-0000-0000-0000-000000000083','Indicado','11933334444','Indicação','10000000-0000-0000-0000-000000000081',false,'2046-01-23T22:12:00-03:00'),
 ('20000000-0000-0000-0000-000000000084','Teste','11944445555','Retorno','10000000-0000-0000-0000-000000000081',true,'2046-01-23T22:12:00-03:00');
INSERT INTO public.queue_entries(id,visit_id,broker_id,queue_type,queue_status,agency,shift,created_at,updated_at,commission_split) VALUES
 ('30000000-0000-0000-0000-000000000082','20000000-0000-0000-0000-000000000082','10000000-0000-0000-0000-000000000082','geral','chamando','Viva Imóveis','tarde','2046-01-23T22:12:00-03:00','2046-01-23T22:12:00-03:00',true),
 ('30000000-0000-0000-0000-000000000083','20000000-0000-0000-0000-000000000083','10000000-0000-0000-0000-000000000082','geral','em_atendimento','Viva Imóveis','tarde','2046-01-23T22:12:00-03:00','2046-01-23T22:12:00-03:00',true),
 ('30000000-0000-0000-0000-000000000084','20000000-0000-0000-0000-000000000084','10000000-0000-0000-0000-000000000081','geral','em_atendimento','Casa Nobre','tarde','2046-01-23T22:12:00-03:00','2046-01-23T22:12:00-03:00',false);
DO $$
BEGIN
 IF public.merit_indicator_counts('10000000-0000-0000-0000-000000000081','2046-01-23T22:00:00-03:00','2046-01-23T23:00:00-03:00')
  <> '{"indicacao":1,"retorno":0,"reserva":0,"pasta_documentos":0}'::jsonb THEN RAISE EXCEPTION 'Chamada ou TESTE contou como mérito real'; END IF;
END $$;
UPDATE public.queue_entries SET queue_status='em_atendimento',updated_at='2046-01-23T22:13:00-03:00' WHERE id='30000000-0000-0000-0000-000000000082';
UPDATE public.queue_entries SET queue_status='concluido',updated_at='2046-01-23T22:20:00-03:00' WHERE id IN('30000000-0000-0000-0000-000000000082','30000000-0000-0000-0000-000000000083');
SELECT public.record_sales_merit_event('{"indicator":"reserva","source_key":"reserva:1","broker_id":"10000000-0000-0000-0000-000000000081","occurred_at":"2046-01-23T22:14:00-03:00"}');
SELECT public.record_sales_merit_event('{"indicator":"reserva","source_key":"reserva:1","broker_id":"10000000-0000-0000-0000-000000000081","occurred_at":"2046-01-23T22:14:00-03:00"}');
SELECT public.record_sales_merit_event('{"indicator":"pasta_documentos","source_key":"pasta:1","broker_id":"10000000-0000-0000-0000-000000000081","occurred_at":"2046-01-23T22:15:00-03:00"}');
DO $$
BEGIN
 IF public.merit_indicator_counts('10000000-0000-0000-0000-000000000081','2046-01-23T22:00:00-03:00','2046-01-23T23:00:00-03:00')
  <> '{"indicacao":1,"retorno":1,"reserva":1,"pasta_documentos":1}'::jsonb THEN RAISE EXCEPTION 'Contadores incorretos'; END IF;
 IF (public.merit_indicator_counts('10000000-0000-0000-0000-000000000081','2046-01-23T22:00:00-03:00','2046-01-23T23:00:00-03:00',true)->>'retorno')::int<>2
 THEN RAISE EXCEPTION 'Não consultou TESTE explicitamente'; END IF;
 IF (public.merit_indicator_counts('10000000-0000-0000-0000-000000000081','2046-01-23T22:13:00-03:00','2046-01-23T22:14:00-03:00')->>'retorno')::int<>1
 THEN RAISE EXCEPTION 'Data do primeiro atendimento perdida na conclusão'; END IF;
 BEGIN
  PERFORM public.record_sales_merit_event('{"indicator":"retorno","source_key":"proibido","broker_id":"10000000-0000-0000-0000-000000000081","occurred_at":"2046-01-23T22:15:00-03:00"}');
  RAISE EXCEPTION 'Aceitou indicador de recepção pela API de vendas';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Indicador, identificador e data inválidos.' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.record_sales_merit_event('{"indicator":"reserva","source_key":"reserva:1","broker_id":"10000000-0000-0000-0000-000000000081","occurred_at":"2046-01-23T22:16:00-03:00"}');
  RAISE EXCEPTION 'Aceitou conflito silencioso de evento';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Este evento já foi registrado com outros dados.' THEN RAISE; END IF; END;
END $$;
-- Manual closing of an extended day uses the same definitive snapshot and recipients.
SELECT public.close_plantao_operation('2046-01-23','2046-01-23T23:00:00-03:00');
RESET ROLE;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM crm_private.plantao_daily_closures WHERE date='2046-01-23' AND closed_by='operacao_stand'
   AND customers @> '[{"name":"Agendado Atendido","type":"Atendimento Agendado","scheduled_time":"22:15:00","designated_broker_id":"10000000-0000-0000-0000-000000000081"}]'
   AND customers @> '[{"name":"Agendado Direto","type":"Atendimento Agendado","scheduled_time":"22:30:00"}]')
 THEN RAISE EXCEPTION 'Snapshot definitivo perdeu dados do agendado'; END IF;
 IF has_table_privilege('anon','crm_private.merit_indicator_events','SELECT') THEN RAISE EXCEPTION 'Tabela privada exposta'; END IF;
END $$;
SET LOCAL ROLE anon;
DO $$
DECLARE result jsonb;
BEGIN
 result:=public.close_plantao_automatically('2046-01-24','2046-01-24T21:00:00-03:00');
 IF result IS NULL OR NOT public.is_plantao_closed('2046-01-24') OR jsonb_array_length(result->'recipients')<>1
 THEN RAISE EXCEPTION 'Fechamento automático ou destinatários ausentes'; END IF;
 IF public.close_plantao_automatically('2046-01-24','2046-01-24T22:00:00-03:00')<>result THEN RAISE EXCEPTION 'Fechamento automático não idempotente'; END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM crm_private.plantao_daily_closures WHERE date='2046-01-24' AND closed_by='fechamento_automatico_21h'
  AND closed_at='2046-01-24T21:00:00-03:00') THEN RAISE EXCEPTION 'Identificador ou horário incorreto'; END IF;
END $$;
CREATE TEMP TABLE expected_merit AS SELECT * FROM crm_private.merit_indicator_events;
CREATE TEMP TABLE expected_facts AS SELECT * FROM public.quantitative_attendance_facts;
SET LOCAL ROLE anon;
SELECT public.reset_test_plantao('2046-01-23',true,'2046-01-23T23:01:00-03:00');
RESET ROLE;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.plantao_sessions WHERE id='operation_2046-01-23') THEN RAISE EXCEPTION 'Reset deixou a chave Caixa'; END IF;
 IF EXISTS((SELECT * FROM expected_merit EXCEPT SELECT * FROM crm_private.merit_indicator_events)
  UNION ALL (SELECT * FROM crm_private.merit_indicator_events EXCEPT SELECT * FROM expected_merit)) THEN RAISE EXCEPTION 'Reset alterou indicadores'; END IF;
 IF EXISTS(SELECT * FROM expected_facts EXCEPT SELECT * FROM public.quantitative_attendance_facts) THEN RAISE EXCEPTION 'Reset apagou quantitativos'; END IF;
END $$;
ROLLBACK;
