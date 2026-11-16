ALTER TABLE public.visits ADD COLUMN is_test boolean NOT NULL DEFAULT false;
ALTER TABLE public.queue_entries
  ADD COLUMN reception_waiting boolean NOT NULL DEFAULT false,
  ADD COLUMN commission_split boolean NOT NULL DEFAULT false;

CREATE SCHEMA IF NOT EXISTS crm_private;
REVOKE ALL ON SCHEMA crm_private FROM PUBLIC, anon, authenticated;

CREATE TABLE crm_private.closing_operators (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('recepcao', 'gerencia', 'diretoria'))
);
CREATE TABLE crm_private.closing_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL CHECK (role IN ('gerencia', 'diretoria')),
  whatsapp text CHECK (whatsapp ~ '^[1-9][0-9]{9,14}$'),
  email text CHECK (email ~ '^[^[:space:]@?,]+@[^[:space:]@?,]+$'),
  CHECK (whatsapp IS NOT NULL OR email IS NOT NULL)
);
CREATE TABLE crm_private.plantao_daily_closures (
  date date PRIMARY KEY,
  closed_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid NOT NULL,
  report_rows jsonb NOT NULL,
  customers jsonb NOT NULL
);
CREATE TABLE crm_private.incorporadora_direct_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name text NOT NULL CHECK (length(trim(customer_name)) > 0),
  phone text CHECK (phone ~ '^[0-9]{10,11}$'),
  visit_reason text NOT NULL CHECK (visit_reason IN ('Primeira visita', 'Retorno', 'Indicação',
    'Indicação Presente', 'Indicação Ausente', 'Indicação Imobiliária', 'Visita ao Decorado', 'Parceria')),
  media_channel text,
  media_channel_detail text,
  created_at timestamptz NOT NULL,
  shift text NOT NULL CHECK (shift IN ('manha', 'tarde')),
  is_test boolean NOT NULL DEFAULT false
);
ALTER TABLE crm_private.closing_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_private.closing_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_private.plantao_daily_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_private.incorporadora_direct_leads ENABLE ROW LEVEL SECURITY;

-- Mutations to a closed operating day and snapshot creation serialize on the same key.
CREATE FUNCTION crm_private.require_open(day date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(21973, day - DATE '2000-01-01');
  IF EXISTS (SELECT 1 FROM crm_private.plantao_daily_closures c WHERE c.date = day) THEN
    RAISE EXCEPTION 'Plantão encerrado para esta data.';
  END IF;
END;
$$;

CREATE FUNCTION public.is_plantao_closed(day date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM crm_private.plantao_daily_closures c WHERE c.date = day)
$$;

CREATE FUNCTION public.record_incorporadora_direct_lead(lead jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  arrived timestamptz := (lead->>'created_at')::timestamptz;
  local_time timestamp := arrived AT TIME ZONE 'America/Sao_Paulo';
  lead_shift text := lead->>'shift';
  chosen_reason text := lead->>'visit_reason';
  digits text := nullif(regexp_replace(lead->>'phone', '[^0-9]', '', 'g'), '');
  lead_id uuid;
BEGIN
  IF local_time IS NULL OR lead_shift IS NULL THEN RAISE EXCEPTION 'Data e turno obrigatórios.'; END IF;
  PERFORM crm_private.require_open(local_time::date);
  IF EXISTS (
    SELECT 1 FROM public.brokers b WHERE NOT b.is_external_partner
      AND NOT b.leave_after_service AND b.presence_status IN ('presente', 'pausa')
      AND (local_time::time < TIME '09:00:00' OR b.shift = lead_shift)
  ) THEN RAISE EXCEPTION 'A presença mudou. Atualize a lista e cadastre novamente.'; END IF;
  INSERT INTO crm_private.incorporadora_direct_leads
    (customer_name, phone, visit_reason, media_channel, media_channel_detail, created_at, shift, is_test)
  VALUES (trim(lead->>'customer_name'), digits, chosen_reason, lead->>'media_channel',
    lead->>'media_channel_detail', arrived, lead_shift, coalesce((lead->>'is_test')::boolean, false))
  RETURNING id INTO lead_id;
  INSERT INTO public.quantitative_attendance_facts
    (source_key, report_date, report_shift, company, team, attendance_type, media_channel)
  VALUES ('direct:' || lead_id, local_time::date, lead_shift, 'Incorporadora', 'Sem Equipe',
    public.report_attendance_type(chosen_reason, NULL), public.report_media(lead->>'media_channel'));
END;
$$;

CREATE FUNCTION crm_private.guard_operational_day() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  previous_day date;
  write_day date;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous_day := (OLD.created_at AT TIME ZONE 'America/Sao_Paulo')::date; END IF;
  IF TG_OP <> 'DELETE' THEN write_day := (NEW.created_at AT TIME ZONE 'America/Sao_Paulo')::date; END IF;
  IF previous_day IS NOT NULL AND write_day IS NOT NULL AND previous_day <> write_day THEN
    PERFORM crm_private.require_open(least(previous_day, write_day));
    PERFORM crm_private.require_open(greatest(previous_day, write_day));
  ELSE
    PERFORM crm_private.require_open(coalesce(previous_day, write_day));
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_visits_operational_day BEFORE INSERT OR UPDATE OR DELETE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION crm_private.guard_operational_day();
CREATE TRIGGER guard_queue_operational_day BEFORE INSERT OR UPDATE OR DELETE ON public.queue_entries
  FOR EACH ROW EXECUTE FUNCTION crm_private.guard_operational_day();
CREATE TRIGGER guard_partner_operational_day BEFORE INSERT OR UPDATE OR DELETE ON public.external_partner_intakes
  FOR EACH ROW EXECUTE FUNCTION crm_private.guard_operational_day();

CREATE FUNCTION crm_private.label_commission_split() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.broker_id IS NULL THEN
    NEW.commission_split := false;
  ELSIF NEW.commission_split THEN
    NEW.applied_rule := 'Transbordo Interempresas (Split)';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER label_commission_split BEFORE INSERT OR UPDATE OF broker_id, commission_split
  ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION crm_private.label_commission_split();

CREATE FUNCTION public.claim_reception_call(
  entry_id uuid, selected_broker uuid, split boolean, called_at_time timestamptz, standard boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE
  q public.queue_entries%ROWTYPE;
  b public.brokers%ROWTYPE;
  owner_id uuid;
  owner_company text;
BEGIN
  SELECT * INTO q FROM public.queue_entries WHERE id = entry_id FOR UPDATE;
  IF NOT FOUND OR q.queue_status <> 'aguardando' OR q.attempts >= 3 THEN RETURN false; END IF;
  SELECT * INTO b FROM public.brokers WHERE id = selected_broker FOR UPDATE;
  IF NOT FOUND OR b.presence_status <> 'presente' OR b.is_external_partner OR b.leave_after_service THEN RETURN false; END IF;
  SELECT v.referred_broker_id, o.agency INTO owner_id, owner_company
  FROM public.visits v LEFT JOIN public.brokers o ON o.id = v.referred_broker_id WHERE v.id = q.visit_id;
  IF b.attendance_status <> 'livre' AND NOT (
    NOT split AND b.id IS NOT DISTINCT FROM owner_id AND b.attendance_status = 'apenas_indicacao'
  ) THEN RETURN false; END IF;
  IF split AND (owner_company IS NULL OR owner_company = b.agency OR b.only_own_referrals) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.queue_entries other WHERE other.broker_id = b.id
      AND other.queue_status IN ('chamando', 'em_atendimento')) THEN RETURN false; END IF;

  UPDATE public.queue_entries SET broker_id = b.id, queue_status = 'chamando',
    attempts = q.attempts + 1, called_at = called_at_time, updated_at = called_at_time,
    commission_split = split WHERE id = q.id;
  UPDATE public.visits SET status = 'aguardando_chamada' WHERE id = q.visit_id;
  UPDATE public.brokers SET attendance_status = 'em_mesa', last_status_update = called_at_time,
    returning_from_pause = CASE WHEN standard THEN false ELSE returning_from_pause END WHERE id = b.id;
  RETURN true;
END;
$$;

CREATE FUNCTION public.close_plantao_day(day date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  operator_id uuid := auth.uid();
  saved crm_private.plantao_daily_closures%ROWTYPE;
  facts jsonb;
  customers jsonb;
  recipients jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crm_private.closing_operators o WHERE o.user_id = operator_id) THEN
    RAISE EXCEPTION 'Usuário sem permissão para fechar o plantão.' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(21973, day - DATE '2000-01-01');
  SELECT * INTO saved FROM crm_private.plantao_daily_closures c WHERE c.date = day;
  IF NOT FOUND THEN
    SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.shift, r.company, r.team, r.type, r.media), '[]') INTO facts
    FROM (SELECT report_date AS date, report_shift AS shift, company, team, attendance_type AS type,
      media_channel AS media, total AS count FROM public.quantitative_report_rows(day, day, NULL)) r;

    SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.arrived_at, r.source_id), '[]') INTO customers
    FROM (
      SELECT 'visit' AS source, v.id AS source_id, v.created_at AS arrived_at,
        v.customer_name AS name, v.phone, v.media_channel AS media, v.media_channel_detail AS media_detail,
        v.visit_reason AS type, q.broker_id, coalesce(q.attending_broker_name, b.operational_name) AS broker,
        v.referred_broker_id AS original_broker_id, q.commission_split
      FROM public.visits v
      JOIN LATERAL (
        SELECT e.* FROM public.queue_entries e WHERE e.visit_id = v.id
          AND e.queue_status IN ('em_atendimento', 'concluido')
        ORDER BY (e.queue_status = 'concluido') DESC, e.updated_at DESC, e.id LIMIT 1
      ) q ON true
      LEFT JOIN public.brokers b ON b.id = q.broker_id
      WHERE (v.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day
      UNION ALL
      SELECT 'direct', l.id, l.created_at, l.customer_name, l.phone, l.media_channel, l.media_channel_detail,
        l.visit_reason, NULL, NULL, NULL, false
      FROM crm_private.incorporadora_direct_leads l WHERE (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day
      UNION ALL
      SELECT 'partner', p.id, p.created_at, coalesce(r.customer_full_name, p.client_first_name),
        r.customer_phone, NULL, NULL, 'Parceria', NULL, p.partner_name, NULL, false
      FROM public.external_partner_intakes p
      LEFT JOIN public.external_partner_reservations r ON r.intake_id = p.id
      WHERE p.manager_status = 'acknowledged' AND (p.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day
    ) r;

    UPDATE public.plantao_sessions SET status = 'ended', ended_at = now()
    WHERE plantao_date = day AND status = 'active';
    UPDATE public.queue_entries SET queue_status = 'ausente', updated_at = now()
    WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = day AND queue_status IN ('aguardando', 'chamando');
    UPDATE public.queue_entries SET queue_status = 'concluido', updated_at = now()
    WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = day AND queue_status = 'em_atendimento';
    UPDATE public.visits SET status = CASE WHEN status = 'em_atendimento' THEN 'encerrado' ELSE 'recusado' END, updated_at = now()
    WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = day
      AND status IN ('aguardando', 'aguardando_chamada', 'em_atendimento');
    UPDATE public.brokers SET presence_status = 'ausente', attendance_status = 'livre', sorteio_order = NULL, inverse_order = NULL
    WHERE NOT is_external_partner AND (arrived_at AT TIME ZONE 'America/Sao_Paulo')::date = day;
    INSERT INTO crm_private.plantao_daily_closures (date, closed_by, report_rows, customers)
    VALUES (day, operator_id, facts, customers) RETURNING * INTO saved;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('role', r.role, 'whatsapp', r.whatsapp, 'email', r.email)
    ORDER BY r.role, r.id), '[]') INTO recipients FROM crm_private.closing_recipients r;
  RETURN jsonb_build_object('date', saved.date, 'closed_at', saved.closed_at, 'rows', saved.report_rows, 'recipients', recipients);
END;
$$;

REVOKE ALL ON FUNCTION public.is_plantao_closed(date),
  public.record_incorporadora_direct_lead(jsonb),
  public.claim_reception_call(uuid, uuid, boolean, timestamptz, boolean),
  public.close_plantao_day(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_plantao_closed(date), public.record_incorporadora_direct_lead(jsonb),
  public.claim_reception_call(uuid, uuid, boolean, timestamptz, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_plantao_day(date) TO authenticated;
