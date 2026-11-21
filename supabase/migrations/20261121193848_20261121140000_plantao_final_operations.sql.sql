-- Additive operation layer: frozen TypeScript distribution motors remain unchanged.
ALTER TABLE public.visits DROP CONSTRAINT visits_visit_reason_check;
ALTER TABLE public.visits ADD CONSTRAINT visits_visit_reason_check CHECK (visit_reason IN (
  'Primeira visita','Retorno','Indicação','Parceria','Visita ao Decorado',
  'Indicação Presente','Indicação Ausente','Indicação Imobiliária','Atendimento Agendado'));
ALTER TABLE public.visits ADD COLUMN scheduled_time time,
  ADD COLUMN designated_broker_id uuid REFERENCES public.brokers(id) ON DELETE SET NULL;
ALTER TABLE crm_private.incorporadora_direct_leads ADD COLUMN scheduled_time time;
ALTER TABLE crm_private.incorporadora_direct_leads DROP CONSTRAINT incorporadora_direct_leads_visit_reason_check;
ALTER TABLE crm_private.incorporadora_direct_leads ADD CONSTRAINT incorporadora_direct_leads_visit_reason_check CHECK (visit_reason IN (
  'Primeira visita','Retorno','Indicação','Parceria','Visita ao Decorado',
  'Indicação Presente','Indicação Ausente','Indicação Imobiliária','Atendimento Agendado'));
ALTER TABLE public.quantitative_attendance_facts DROP CONSTRAINT quantitative_attendance_facts_attendance_type_check;
ALTER TABLE public.quantitative_attendance_facts ADD CONSTRAINT quantitative_attendance_facts_attendance_type_check
  CHECK (attendance_type IN ('Primeira Visita','Indicação','Retorno','Visita ao Decorado','Parceria Externa','Atendimento Agendado'));

CREATE OR REPLACE FUNCTION public.report_attendance_type(reason text, queue_kind text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN queue_kind='parceria' OR reason='Parceria' THEN 'Parceria Externa'
 WHEN queue_kind='decorado' OR reason IN ('Decorado','Visita ao Decorado') THEN 'Visita ao Decorado'
 WHEN reason LIKE 'Indicação%' THEN 'Indicação'
 WHEN reason='Retorno' THEN 'Retorno' WHEN reason='Atendimento Agendado' THEN 'Atendimento Agendado'
 ELSE 'Primeira Visita' END;
$$;

CREATE FUNCTION public.set_plantao_day_extension(day date, enabled boolean, at_time timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF day IS NULL OR enabled IS NULL OR at_time IS NULL THEN RAISE EXCEPTION 'Data, opção e horário obrigatórios.'; END IF;
  PERFORM pg_advisory_xact_lock(21973, day - DATE '2000-01-01');
  PERFORM crm_private.require_open(day);
  INSERT INTO public.plantao_sessions(id,plantao_date,status,started_at,ended_at,schedule_data)
  VALUES('operation_'||day::text,day,'ended',at_time,at_time,jsonb_build_object('kind','operation_day_v1','cashSigning',enabled))
  ON CONFLICT(id) DO UPDATE SET schedule_data=excluded.schedule_data WHERE plantao_sessions.id=excluded.id;
END;
$$;
CREATE FUNCTION public.close_plantao_automatically(day date, at_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF day IS NULL OR at_time IS NULL OR (at_time AT TIME ZONE 'America/Sao_Paulo')::date <> day THEN
    RAISE EXCEPTION 'O horário deve pertencer ao dia operacional.';
  END IF;
  PERFORM pg_advisory_xact_lock(21973, day - DATE '2000-01-01');
  IF (at_time AT TIME ZONE 'America/Sao_Paulo')::time < TIME '21:00:00' OR EXISTS (
    SELECT 1 FROM public.plantao_sessions WHERE id='operation_'||day::text
      AND schedule_data->>'kind'='operation_day_v1' AND schedule_data->>'cashSigning'='true'
  ) THEN RETURN NULL; END IF;
  RETURN crm_private.complete_plantao_day(day,'fechamento_automatico_21h',at_time);
END;
$$;
REVOKE ALL ON FUNCTION public.set_plantao_day_extension(date,boolean,timestamptz), public.close_plantao_automatically(date,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_plantao_day_extension(date,boolean,timestamptz), public.close_plantao_automatically(date,timestamptz) TO anon,authenticated;

-- Exactly the existing completion path, with appointments classified as ordinary direct service.
CREATE OR REPLACE FUNCTION public.conclude_queue_attendance(entry_id uuid, clicked_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE entry queue_entries%ROWTYPE; reason text; rank bigint := floor(extract(epoch FROM clicked_at) * 1000);
BEGIN
  SELECT * INTO entry FROM queue_entries WHERE id = entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found'; END IF;
  IF entry.queue_status = 'concluido' THEN RETURN; END IF;
  SELECT visit_reason INTO reason FROM visits WHERE id = entry.visit_id;
  UPDATE brokers SET
    sorteio_order = CASE
      WHEN entry.queue_type = 'geral' AND (reason = 'Retorno' OR reason LIKE 'Indicação%') AND merit_priority_return THEN -rank
      WHEN entry.queue_type = 'geral' AND reason IN ('Primeira visita','Atendimento Agendado') THEN rank
      ELSE sorteio_order END,
    inverse_order = CASE WHEN entry.queue_type = 'decorado' THEN rank ELSE inverse_order END,
    merit_priority_return = false, attendance_status = 'livre', last_status_update = clicked_at
  WHERE id = entry.broker_id;
  UPDATE visits SET status = 'encerrado' WHERE id = entry.visit_id;
  UPDATE queue_entries SET queue_status = 'concluido', updated_at = clicked_at WHERE id = entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_incorporadora_direct_lead(lead jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  arrived timestamptz := (lead->>'created_at')::timestamptz;
  local_time timestamp := arrived AT TIME ZONE 'America/Sao_Paulo';
  lead_shift text := lead->>'shift'; chosen_reason text := lead->>'visit_reason';
  digits text := nullif(regexp_replace(lead->>'phone', '[^0-9]', '', 'g'), ''); lead_id uuid;
BEGIN
  IF local_time IS NULL OR lead_shift IS NULL THEN RAISE EXCEPTION 'Data e turno obrigatórios.'; END IF;
  PERFORM crm_private.require_open(local_time::date);
  IF EXISTS (SELECT 1 FROM public.brokers b WHERE NOT b.is_external_partner AND NOT b.leave_after_service
    AND b.presence_status IN ('presente', 'pausa') AND (local_time::time < TIME '09:00:00' OR b.shift = lead_shift))
    THEN RAISE EXCEPTION 'A presença mudou. Atualize a lista e cadastre novamente.'; END IF;
  INSERT INTO crm_private.incorporadora_direct_leads
    (customer_name,phone,visit_reason,media_channel,media_channel_detail,created_at,shift,is_test,scheduled_time)
  VALUES(trim(lead->>'customer_name'),digits,chosen_reason,lead->>'media_channel',lead->>'media_channel_detail',
    arrived,lead_shift,coalesce((lead->>'is_test')::boolean,false),nullif(lead->>'scheduled_time','')::time)
  RETURNING id INTO lead_id;
  INSERT INTO public.quantitative_attendance_facts(source_key,report_date,report_shift,company,team,attendance_type,media_channel)
  VALUES('direct:'||lead_id,local_time::date,lead_shift,'Incorporadora','Sem Equipe',
    public.report_attendance_type(chosen_reason,NULL),public.report_media(lead->>'media_channel'));
END;
$$;

-- Enrich the definitive snapshot only at insertion; later consultation cannot change it.
CREATE FUNCTION crm_private.capture_scheduled_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  SELECT coalesce(jsonb_agg(item || CASE WHEN item->>'type'='Atendimento Agendado' THEN
    jsonb_build_object('scheduled_time',coalesce(v.scheduled_time,l.scheduled_time),'designated_broker_id',v.designated_broker_id)
    ELSE '{}'::jsonb END ORDER BY position),'[]'::jsonb) INTO NEW.customers
  FROM jsonb_array_elements(NEW.customers) WITH ORDINALITY AS source(item,position)
  LEFT JOIN public.visits v ON item->>'source'='visit' AND v.id::text=item->>'source_id'
  LEFT JOIN crm_private.incorporadora_direct_leads l ON item->>'source'='direct' AND l.id::text=item->>'source_id';
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_scheduled_snapshot BEFORE INSERT ON crm_private.plantao_daily_closures
  FOR EACH ROW EXECUTE FUNCTION crm_private.capture_scheduled_snapshot();
REVOKE ALL ON FUNCTION crm_private.capture_scheduled_snapshot() FROM PUBLIC,anon,authenticated;

-- Dated facts for future rolling windows. No score, weighting or ranking is calculated.
-- No cascading FK: operational TESTE reset must not erase historical facts.
CREATE TABLE crm_private.merit_indicator_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_key text NOT NULL CHECK (length(trim(source_key)) BETWEEN 1 AND 200),
  broker_id uuid NOT NULL, indicator text NOT NULL CHECK (indicator IN ('indicacao','retorno','reserva','pasta_documentos')),
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)), is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(indicator,source_key)
);
CREATE INDEX merit_broker_window ON crm_private.merit_indicator_events(broker_id,occurred_at,indicator);
REVOKE ALL ON crm_private.merit_indicator_events FROM PUBLIC,anon,authenticated;

CREATE FUNCTION crm_private.capture_reception_merit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v public.visits%ROWTYPE; kind text; owner_id uuid;
BEGIN
  IF NEW.queue_status NOT IN ('em_atendimento','concluido') OR NEW.broker_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v FROM public.visits WHERE id=NEW.visit_id;
  kind := CASE WHEN v.visit_reason='Retorno' THEN 'retorno' WHEN v.visit_reason LIKE 'Indicação%' THEN 'indicacao' END;
  IF kind IS NULL THEN RETURN NEW; END IF;
  owner_id := coalesce(v.referred_broker_id,NEW.broker_id);
  IF NOT EXISTS (SELECT 1 FROM public.brokers WHERE id=owner_id AND NOT is_external_partner) THEN RETURN NEW; END IF;
  INSERT INTO crm_private.merit_indicator_events(source_key,broker_id,indicator,occurred_at,is_test)
  VALUES('queue:'||NEW.id,owner_id,kind,coalesce(NEW.updated_at,NEW.called_at,NEW.created_at),coalesce(v.is_test,false))
  ON CONFLICT(indicator,source_key) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_reception_merit AFTER INSERT OR UPDATE ON public.queue_entries
  FOR EACH ROW EXECUTE FUNCTION crm_private.capture_reception_merit();
REVOKE ALL ON FUNCTION crm_private.capture_reception_merit() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.record_sales_merit_event(event jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  kind text := event->>'indicator'; source text := trim(event->>'source_key'); broker uuid := (event->>'broker_id')::uuid;
  happened timestamptz := (event->>'occurred_at')::timestamptz; testing boolean := coalesce((event->>'is_test')::boolean,false);
  saved crm_private.merit_indicator_events%ROWTYPE;
BEGIN
  IF kind IS NULL OR kind NOT IN ('reserva','pasta_documentos') OR nullif(source,'') IS NULL OR happened IS NULL OR NOT isfinite(happened)
    THEN RAISE EXCEPTION 'Indicador, identificador e data inválidos.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.brokers WHERE id=broker AND NOT is_external_partner) THEN RAISE EXCEPTION 'Corretor interno não encontrado.'; END IF;
  INSERT INTO crm_private.merit_indicator_events(source_key,broker_id,indicator,occurred_at,is_test)
  VALUES(source,broker,kind,happened,testing) ON CONFLICT(indicator,source_key) DO NOTHING;
  SELECT * INTO saved FROM crm_private.merit_indicator_events WHERE indicator=kind AND source_key=source;
  IF saved.broker_id<>broker OR saved.occurred_at<>happened OR saved.is_test<>testing
    THEN RAISE EXCEPTION 'Este evento já foi registrado com outros dados.'; END IF;
END;
$$;
CREATE FUNCTION public.merit_indicator_counts(broker uuid, from_at timestamptz, until_at timestamptz, include_tests boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  IF from_at IS NULL OR until_at IS NULL OR NOT isfinite(from_at) OR NOT isfinite(until_at) OR from_at>=until_at THEN
    RAISE EXCEPTION 'Janela de indicadores inválida.';
  END IF;
  SELECT jsonb_build_object('indicacao',count(*) FILTER(WHERE indicator='indicacao'),
    'retorno',count(*) FILTER(WHERE indicator='retorno'),'reserva',count(*) FILTER(WHERE indicator='reserva'),
    'pasta_documentos',count(*) FILTER(WHERE indicator='pasta_documentos')) INTO result
  FROM crm_private.merit_indicator_events WHERE broker_id=broker AND occurred_at>=from_at AND occurred_at<until_at
    AND (include_tests OR NOT is_test);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.record_sales_merit_event(jsonb), public.merit_indicator_counts(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_sales_merit_event(jsonb), public.merit_indicator_counts(uuid,timestamptz,timestamptz,boolean) TO anon,authenticated;
NOTIFY pgrst, 'reload schema';