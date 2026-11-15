ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS media_channel text,
  ADD COLUMN IF NOT EXISTS media_channel_detail text;

CREATE FUNCTION public.clean_visit_media_detail() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  NEW.media_channel_detail := CASE WHEN NEW.media_channel='Outros' THEN nullif(trim(NEW.media_channel_detail),'') ELSE NULL END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clean_visit_media_detail BEFORE INSERT OR UPDATE OF media_channel,media_channel_detail ON public.visits
FOR EACH ROW EXECUTE FUNCTION public.clean_visit_media_detail();

-- Historical quantitative facts have no customer/broker name, telephone or FK
-- to mutable operational rows. Queue cleanup must not erase weekly totals.
CREATE TABLE public.quantitative_attendance_facts (
  source_key text PRIMARY KEY,
  report_date date NOT NULL,
  report_shift text NOT NULL CHECK (report_shift IN ('manha','tarde')),
  company text NOT NULL,
  team text NOT NULL,
  attendance_type text NOT NULL CHECK (attendance_type IN ('Primeira Visita','Indicação','Retorno','Visita ao Decorado','Parceria Externa')),
  media_channel text NOT NULL
);
CREATE INDEX quantitative_report_period ON public.quantitative_attendance_facts(report_date,report_shift);
ALTER TABLE public.quantitative_attendance_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY quantitative_facts_read ON public.quantitative_attendance_facts FOR SELECT TO anon,authenticated USING(true);
GRANT SELECT ON public.quantitative_attendance_facts TO anon,authenticated;

CREATE FUNCTION public.report_media(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN nullif(trim(value),'') IS NULL THEN 'Outros'
 WHEN lower(trim(value)) IN ('oferta ativa (lista perfil)','oferta ativa','lista incorporadora') THEN 'Oferta Ativa (Lista Perfil)'
 WHEN lower(trim(value)) IN ('pontos de captação (supermercados/metrô/feiras)') THEN 'Pontos de Captação (Supermercados/Metrô/Feiras)'
 WHEN lower(trim(value)) IN ('panfletagem (incorporadora)') THEN 'Panfletagem (Incorporadora)'
 WHEN lower(trim(value)) IN ('redes sociais (instagram/facebook)','instagram','facebook') THEN 'Redes Sociais (Instagram/Facebook)'
 WHEN lower(trim(value)) IN ('google / pesquisa','google') THEN 'Google / Pesquisa'
 WHEN lower(trim(value)) IN ('portais imobiliários','portais') THEN 'Portais Imobiliários'
 WHEN lower(trim(value)) IN ('mídia tradicional & transporte (rádio/tv/ônibus)') THEN 'Mídia Tradicional & Transporte (Rádio/TV/Ônibus)'
 WHEN lower(trim(value)) IN ('placa / passante','placa/passante') THEN 'Placa / Passante'
 WHEN lower(trim(value)) IN ('outros') THEN 'Outros'
 ELSE 'Outros' END;
$$;
CREATE FUNCTION public.report_attendance_type(reason text, queue_kind text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN queue_kind='parceria' OR reason='Parceria' THEN 'Parceria Externa'
 WHEN queue_kind='decorado' OR reason IN ('Decorado','Visita ao Decorado') THEN 'Visita ao Decorado'
 WHEN reason LIKE 'Indicação%' THEN 'Indicação'
 WHEN reason='Retorno' THEN 'Retorno' ELSE 'Primeira Visita' END;
$$;
CREATE FUNCTION public.capture_quantitative_attendance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE e queue_entries%ROWTYPE; v visits%ROWTYPE; b brokers%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN e:=OLD; ELSE e:=NEW; END IF;
  IF e.queue_status NOT IN ('em_atendimento','concluido') THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT * INTO v FROM visits WHERE id=e.visit_id;
  SELECT * INTO b FROM brokers WHERE id=e.broker_id;
  INSERT INTO quantitative_attendance_facts(source_key,report_date,report_shift,company,team,attendance_type,media_channel)
  VALUES('queue:'||e.id, (coalesce(v.created_at,e.created_at) AT TIME ZONE 'America/Sao_Paulo')::date,
    coalesce(e.shift,'manha'),coalesce(b.agency,e.agency,'Empresa não informada'),coalesce(nullif(trim(b.equipe),''),'Sem Equipe'),
    report_attendance_type(v.visit_reason,e.queue_type),report_media(v.media_channel))
  ON CONFLICT(source_key) DO UPDATE SET report_shift=excluded.report_shift;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER capture_quantitative_attendance AFTER INSERT OR UPDATE OR DELETE ON public.queue_entries
FOR EACH ROW EXECUTE FUNCTION public.capture_quantitative_attendance();

CREATE FUNCTION public.capture_quantitative_partner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE day date; afternoon boolean;
BEGIN
  IF NEW.manager_status <> 'acknowledged' THEN RETURN NEW; END IF;
  day:=(NEW.created_at AT TIME ZONE 'America/Sao_Paulo')::date;
  SELECT EXISTS(SELECT 1 FROM plantao_sessions WHERE id='schedule_'||day::text||'_afternoon') INTO afternoon;
  INSERT INTO quantitative_attendance_facts VALUES('partner:'||NEW.id,day,
    CASE WHEN afternoon AND (NEW.created_at AT TIME ZONE 'America/Sao_Paulo')::time >= '14:00:01' THEN 'tarde' ELSE 'manha' END,
    coalesce(nullif(trim(NEW.company),''),'Autônomo'),'Parcerias','Parceria Externa','Outros') ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_quantitative_partner AFTER INSERT OR UPDATE ON public.external_partner_intakes
FOR EACH ROW EXECUTE FUNCTION public.capture_quantitative_partner();

-- Backfill available history without changing any queue or broker.
INSERT INTO public.quantitative_attendance_facts
SELECT 'queue:'||q.id,(coalesce(v.created_at,q.created_at) AT TIME ZONE 'America/Sao_Paulo')::date,
 coalesce(q.shift,'manha'),coalesce(b.agency,q.agency,'Empresa não informada'),coalesce(nullif(trim(b.equipe),''),'Sem Equipe'),
 public.report_attendance_type(v.visit_reason,q.queue_type),public.report_media(v.media_channel)
FROM public.queue_entries q LEFT JOIN public.visits v ON v.id=q.visit_id LEFT JOIN public.brokers b ON b.id=q.broker_id
WHERE q.queue_status IN ('em_atendimento','concluido') ON CONFLICT DO NOTHING;
INSERT INTO public.quantitative_attendance_facts
SELECT 'queue:'||(e->>'id'), (coalesce(v.created_at,r.created_at) AT TIME ZONE 'America/Sao_Paulo')::date,
 coalesce(nullif(e->>'shift',''),r.shift),coalesce(b.agency,e->>'agency','Empresa não informada'),coalesce(nullif(trim(b.equipe),''),'Sem Equipe'),
 public.report_attendance_type(coalesce(v.visit_reason,e->'visit'->>'visit_reason'),e->>'queue_type'),public.report_media(v.media_channel)
FROM public.relatorio_fechamento r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot_data) e
LEFT JOIN public.visits v ON v.id::text=e->>'visit_id' LEFT JOIN public.brokers b ON b.id::text=e->>'broker_id'
WHERE e->>'id' IS NOT NULL AND e->>'queue_status'='concluido' ON CONFLICT DO NOTHING;
INSERT INTO public.quantitative_attendance_facts
SELECT 'partner:'||p.id,(p.created_at AT TIME ZONE 'America/Sao_Paulo')::date,
 CASE WHEN (p.created_at AT TIME ZONE 'America/Sao_Paulo')::time >= '14:00:01' AND EXISTS(SELECT 1 FROM public.plantao_sessions s WHERE s.id='schedule_'||(p.created_at AT TIME ZONE 'America/Sao_Paulo')::date::text||'_afternoon') THEN 'tarde' ELSE 'manha' END,
 coalesce(nullif(trim(p.company),''),'Autônomo'),'Parcerias','Parceria Externa','Outros'
FROM public.external_partner_intakes p WHERE p.manager_status='acknowledged' ON CONFLICT DO NOTHING;

CREATE FUNCTION public.quantitative_report_rows(from_date date,to_date date,company_filter text DEFAULT NULL)
RETURNS TABLE(report_date date,report_shift text,company text,team text,attendance_type text,media_channel text,total bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT f.report_date,f.report_shift,f.company,f.team,f.attendance_type,f.media_channel,count(*)
 FROM quantitative_attendance_facts f WHERE f.report_date BETWEEN from_date AND to_date AND (company_filter IS NULL OR f.company=company_filter)
 GROUP BY f.report_date,f.report_shift,f.company,f.team,f.attendance_type,f.media_channel
 ORDER BY f.report_date,f.report_shift,f.company,f.team,f.attendance_type,f.media_channel;
$$;
GRANT EXECUTE ON FUNCTION public.quantitative_report_rows(date,date,text) TO anon,authenticated;
