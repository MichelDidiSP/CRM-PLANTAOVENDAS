\set ON_ERROR_STOP on
BEGIN;
-- Compatibility test only: uses the existing schema, RLS and pg-safeupdate.
INSERT INTO public.brokers (id, operational_name, agency, equipe, presence_status, attendance_status, shift, arrived_at, sorteio_order, inverse_order) VALUES
 ('11000000-0000-0000-0000-000000000001', 'Original', 'Viva Imóveis', 'A', 'ausente', 'livre', 'manha', NULL, 1, 3),
 ('11000000-0000-0000-0000-000000000002', 'Equipe', 'Viva Imóveis', 'A', 'presente', 'livre', 'manha', '2041-01-23T08:30:00-03:00', 2, 1),
 ('11000000-0000-0000-0000-000000000003', 'Outra Empresa', 'Casa Nobre', 'B', 'presente', 'livre', 'manha', '2041-01-23T08:31:00-03:00', 1, 2);
INSERT INTO public.visits (id, customer_name, phone, visit_reason, referred_broker_id, created_at, is_test) VALUES
 ('22000000-0000-0000-0000-000000000001', 'Cliente Retorno', '11987654321', 'Retorno', '11000000-0000-0000-0000-000000000001', '2041-01-23T08:30:00-03:00', true),
 ('22000000-0000-0000-0000-000000000002', 'Cliente Decorado', NULL, 'Visita ao Decorado', NULL, '2041-01-23T08:30:00-03:00', true);
INSERT INTO public.queue_entries (id, visit_id, agency, queue_type, shift, reception_waiting, created_at) VALUES
 ('33000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', 'Viva Imóveis', 'geral', 'manha', true, '2041-01-23T08:30:00-03:00'),
 ('33000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000002', 'Viva Imóveis', 'decorado', 'manha', false, '2041-01-23T08:30:00-03:00');
SET LOCAL ROLE anon;
INSERT INTO public.plantao_sessions (id, status, plantao_date, schedule_data) VALUES
 ('reception_33000000-0000-0000-0000-000000000001', 'ended', '2041-01-23', '{"kind":"reception_v1","mode":"coverage","ownerId":"11000000-0000-0000-0000-000000000001"}');
DO $$ BEGIN
 IF public.claim_reception_call('33000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000002', true, '2041-01-23T08:32:00-03:00') THEN
   RAISE EXCEPTION 'A restrição original da RPC mudou; reavalie a compatibilidade.';
 END IF;
 IF NOT public.claim_reception_call('33000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000002', false, '2041-01-23T08:32:00-03:00') THEN
   RAISE EXCEPTION 'Não foi possível reservar a chamada da equipe.';
 END IF;
END $$;
UPDATE public.queue_entries SET commission_split = true WHERE id = '33000000-0000-0000-0000-000000000001' AND broker_id = '11000000-0000-0000-0000-000000000002';
UPDATE public.queue_entries SET applied_rule = 'Último da Equipe (Split)' WHERE id = '33000000-0000-0000-0000-000000000001';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.queue_entries WHERE id = '33000000-0000-0000-0000-000000000001'
   AND commission_split AND applied_rule = 'Último da Equipe (Split)') THEN RAISE EXCEPTION 'Split da equipe não foi preservado.'; END IF;
END $$;
-- Complete this call, then exercise the exact refusal writes as anon.
SELECT public.conclude_queue_attendance('33000000-0000-0000-0000-000000000001', '2041-01-23T08:35:00-03:00');
SELECT public.claim_reception_call('33000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000002', false, '2041-01-23T08:36:00-03:00');
UPDATE public.queue_entries SET queue_status = 'ausente' WHERE id = '33000000-0000-0000-0000-000000000002' AND queue_status = 'chamando' AND broker_id = '11000000-0000-0000-0000-000000000002';
INSERT INTO public.plantao_sessions (id, status, plantao_date, schedule_data) VALUES
 ('reception_33000000-0000-0000-0000-000000000002', 'ended', '2041-01-23', '{"kind":"reception_v1","events":[{"type":"inverse_refusal","position":2}]}');
UPDATE public.brokers SET inverse_order = 4, attendance_status = 'livre' WHERE id = '11000000-0000-0000-0000-000000000002';
UPDATE public.visits SET status = 'aguardando' WHERE id = '22000000-0000-0000-0000-000000000002';
UPDATE public.queue_entries SET queue_status = 'aguardando', broker_id = NULL, attempts = 0, called_at = NULL, reception_waiting = true WHERE id = '33000000-0000-0000-0000-000000000002' AND queue_status = 'ausente';
DO $$ BEGIN
 IF NOT public.claim_reception_call('33000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000003', false, '2041-01-23T08:37:00-03:00') THEN
   RAISE EXCEPTION 'Recusa não permitiu chamar o próximo corretor.';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.brokers WHERE id = '11000000-0000-0000-0000-000000000002' AND sorteio_order = 2 AND inverse_order = 4) THEN
   RAISE EXCEPTION 'Recusa alterou a posição direta.';
 END IF;
 IF EXISTS (SELECT 1 FROM public.plantao_sessions WHERE id LIKE 'reception_%' AND status = 'active') THEN
   RAISE EXCEPTION 'Metadados de recepção interferiram na sessão ativa.';
 END IF;
END $$;
SELECT public.reset_test_plantao('2041-01-23', true, '2041-01-23T19:00:00-03:00');
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.plantao_sessions WHERE id LIKE 'reception_%' AND plantao_date = '2041-01-23') THEN
   RAISE EXCEPTION 'Reset deixou decisões de espera/recusa do dia anterior.';
 END IF;
END $$;
RESET ROLE;
ROLLBACK;
