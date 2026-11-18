\set ON_ERROR_STOP on
BEGIN;

-- Fail if CI accidentally stops loading the same protection used by Supabase.
DO $$
BEGIN
  IF current_setting('safeupdate.enabled') <> 'on' THEN
    RAISE EXCEPTION 'pg-safeupdate precisa estar ativo neste teste.';
  END IF;
END $$;
CREATE TEMP TABLE safeupdate_probe (id integer PRIMARY KEY, value text);
INSERT INTO safeupdate_probe VALUES (1, 'original');
DO $$
BEGIN
  BEGIN
    EXECUTE 'UPDATE safeupdate_probe SET value = ''unsafe''';
    RAISE EXCEPTION 'UPDATE sem WHERE foi aceito.';
  EXCEPTION WHEN cardinality_violation THEN
    IF SQLERRM <> 'UPDATE requires a WHERE clause' THEN RAISE; END IF;
  END;
  BEGIN
    EXECUTE 'DELETE FROM safeupdate_probe';
    RAISE EXCEPTION 'DELETE sem WHERE foi aceito.';
  EXCEPTION WHEN cardinality_violation THEN
    IF SQLERRM <> 'DELETE requires a WHERE clause' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO crm_private.incorporadora_direct_leads
  (customer_name, phone, visit_reason, media_channel, is_test, shift, created_at) VALUES
  ('Início do dia', '11911110001', 'Primeira visita', 'Google', true, 'manha', '2046-04-10T03:00:00Z'),
  ('Fim do dia', '11911110002', 'Primeira visita', 'Google', true, 'tarde', '2046-04-11T02:59:59Z'),
  ('Outro dia', '11911110003', 'Primeira visita', 'Google', true, 'manha', '2046-04-11T03:00:00Z'),
  ('Dia anterior', '11911110004', 'Primeira visita', 'Google', true, 'manha', '2046-04-10T02:59:59Z'),
  ('Cliente real privado', '11911110005', 'Primeira visita', 'Google', false, 'manha', '2046-04-10T12:00:00Z');

SET LOCAL ROLE anon;
DO $$
BEGIN
  IF has_schema_privilege(current_user, 'crm_private', 'USAGE')
    OR has_table_privilege(current_user, 'public.test_incorporadora_direct_leads', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'A leitura de teste ampliou acesso à base privada ou permitiu escrita.';
  END IF;
  IF (SELECT count(*) FROM public.test_incorporadora_direct_leads) <> 4
    OR EXISTS (SELECT 1 FROM public.test_incorporadora_direct_leads WHERE phone = '11911110005') THEN
    RAISE EXCEPTION 'A projeção expôs um cliente não marcado como teste.';
  END IF;
  IF (SELECT array_agg(phone ORDER BY phone) FROM public.test_incorporadora_direct_leads WHERE test_date = '2046-04-10')
    IS DISTINCT FROM ARRAY['11911110001', '11911110002'] THEN
    RAISE EXCEPTION 'A leitura do dia não respeitou o fuso de São Paulo.';
  END IF;
  IF (SELECT count(*) FROM public.test_incorporadora_direct_leads WHERE test_date = '2046-04-12') <> 0 THEN
    RAISE EXCEPTION 'Dia vazio deveria retornar lista vazia.';
  END IF;
  PERFORM public.reset_test_plantao('2046-04-10', true, '2046-04-10T19:00:00-03:00');
  IF EXISTS (SELECT 1 FROM public.test_incorporadora_direct_leads WHERE test_date = '2046-04-10')
    OR (SELECT count(*) FROM public.test_incorporadora_direct_leads) <> 2 THEN
    RAISE EXCEPTION 'O reset não atualizou a projeção ou removeu outro dia.';
  END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.test_incorporadora_direct_leads WHERE test_date = '2046-04-11') <> 1 THEN
    RAISE EXCEPTION 'A leitura do TESTE também deve funcionar para authenticated.';
  END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crm_private.incorporadora_direct_leads WHERE phone = '11911110005' AND NOT is_test) THEN
    RAISE EXCEPTION 'O reset apagou o cliente real.';
  END IF;
END $$;
ROLLBACK;
