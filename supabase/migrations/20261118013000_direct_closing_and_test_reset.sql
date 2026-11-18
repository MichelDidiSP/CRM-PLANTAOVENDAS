-- Temporary operation without an authentication module. Personal snapshots remain private.
ALTER TABLE crm_private.plantao_daily_closures
  ALTER COLUMN closed_by TYPE text USING closed_by::text;

CREATE FUNCTION crm_private.complete_plantao_day(day date, operation_id text, at_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  saved crm_private.plantao_daily_closures%ROWTYPE;
  facts jsonb;
  customers jsonb;
  recipients jsonb;
BEGIN
  IF day IS NULL OR at_time IS NULL THEN RAISE EXCEPTION 'Data e horário obrigatórios.'; END IF;
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
      SELECT 'partner', p.id, p.created_at, coalesce(r.customer_full_name, d.customer_name, p.client_first_name),
        coalesce(r.customer_phone, d.phone), d.media_channel, d.media_channel_detail, 'Parceria', NULL, p.partner_name, NULL, false
      FROM public.external_partner_intakes p
      LEFT JOIN public.external_partner_reservations r ON r.intake_id = p.id
      LEFT JOIN crm_private.partner_reception_details d ON d.intake_id = p.id
      WHERE p.manager_status = 'acknowledged' AND (p.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day
    ) r;

    UPDATE public.plantao_sessions SET status = 'ended', ended_at = at_time
    WHERE plantao_date = day AND status = 'active';
    UPDATE public.queue_entries SET queue_status = 'ausente', updated_at = at_time
    WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = day AND queue_status IN ('aguardando', 'chamando');
    UPDATE public.queue_entries SET queue_status = 'concluido', updated_at = at_time
    WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = day AND queue_status = 'em_atendimento';
    UPDATE public.visits SET status = CASE WHEN status = 'em_atendimento' THEN 'encerrado' ELSE 'recusado' END, updated_at = at_time
    WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = day
      AND status IN ('aguardando', 'aguardando_chamada', 'em_atendimento');
    UPDATE public.brokers SET presence_status = 'ausente', attendance_status = 'livre', sorteio_order = NULL, inverse_order = NULL
    WHERE NOT is_external_partner AND (arrived_at AT TIME ZONE 'America/Sao_Paulo')::date = day;
    INSERT INTO crm_private.plantao_daily_closures (date, closed_at, closed_by, report_rows, customers)
    VALUES (day, at_time, operation_id, facts, customers) RETURNING * INTO saved;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('role', r.role, 'whatsapp', r.whatsapp, 'email', r.email)
    ORDER BY r.role, r.id), '[]') INTO recipients FROM crm_private.closing_recipients r;
  RETURN jsonb_build_object('date', saved.date, 'closed_at', saved.closed_at, 'rows', saved.report_rows, 'recipients', recipients);
END;
$$;

REVOKE ALL ON FUNCTION crm_private.complete_plantao_day(date, text, timestamptz) FROM PUBLIC, anon, authenticated;

-- Preserve the authenticated entry point for the future operator module.
CREATE OR REPLACE FUNCTION public.close_plantao_day(day date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE operator_id uuid := auth.uid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crm_private.closing_operators o WHERE o.user_id = operator_id) THEN
    RAISE EXCEPTION 'Usuário sem permissão para fechar o plantão.' USING ERRCODE = '42501';
  END IF;
  RETURN crm_private.complete_plantao_day(day, operator_id::text, now());
END;
$$;

CREATE FUNCTION public.close_plantao_operation(day date, at_time timestamptz) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT crm_private.complete_plantao_day(day, 'operacao_stand', at_time)
$$;
REVOKE ALL ON FUNCTION public.close_plantao_operation(date, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_plantao_operation(date, timestamptz) TO anon, authenticated;

-- Explicit TESTE action. This flag expresses intent, not operator authentication.
CREATE FUNCTION public.reset_test_plantao(day date, test_mode boolean, at_time timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF test_mode IS DISTINCT FROM true THEN RAISE EXCEPTION 'Ative o módulo TESTE para reiniciar o plantão.'; END IF;
  IF day IS NULL OR at_time IS NULL THEN RAISE EXCEPTION 'Data e horário obrigatórios.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('shift_schedule_' || day::text));
  PERFORM pg_advisory_xact_lock(21973, day - DATE '2000-01-01');

  -- Reopen inside the same transaction before the closed-day mutation guards run.
  DELETE FROM crm_private.plantao_daily_closures c WHERE c.date = day;
  -- Delete queues before test visits so the quantitative trigger still has its source.
  -- quantitative_attendance_facts has no cascading FK to these operational records.
  DELETE FROM public.queue_entries q
    WHERE (q.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day
      OR EXISTS (SELECT 1 FROM public.visits v WHERE v.id = q.visit_id
        AND (v.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day);
  DELETE FROM public.visits v WHERE v.is_test AND (v.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day;
  UPDATE public.visits v SET status = 'encerrado', updated_at = at_time
    WHERE NOT v.is_test AND (v.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day;
  DELETE FROM crm_private.incorporadora_direct_leads l
    WHERE l.is_test AND (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day;

  DELETE FROM public.external_partner_reservations r USING public.external_partner_intakes p
    WHERE r.intake_id = p.id AND (p.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day;
  DELETE FROM crm_private.partner_reception_details d USING public.external_partner_intakes p
    WHERE d.intake_id = p.id AND (p.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day;
  DELETE FROM public.external_partner_intakes p WHERE (p.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day;
  DELETE FROM public.pause_audit p WHERE p.scope LIKE day::text || ':%'
    OR (p.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date = day;
  DELETE FROM public.plantao_sessions s WHERE s.plantao_date = day
    OR (s.plantao_date IS NULL AND (s.started_at AT TIME ZONE 'America/Sao_Paulo')::date = day);
  DELETE FROM public.relatorio_fechamento r WHERE (r.created_at AT TIME ZONE 'America/Sao_Paulo')::date = day;

  UPDATE public.brokers SET presence_status = 'ausente', attendance_status = 'livre', arrived_at = NULL, shift = NULL,
    sorteio_order = NULL, inverse_order = NULL, afternoon_enrolled_at = NULL, afternoon_reserved = false,
    preserve_shift_position = false, leave_after_service = false, returning_from_pause = false, merit_priority_return = false,
    pause_started_at = NULL, pause_scope = NULL, pause_exit_index = NULL, pause_exit_order = NULL,
    pause_inverse_order = NULL, pause_direct_snapshot = '{}', manager_excused = false,
    only_own_referrals = false, restriction_reason = NULL, restriction_scope = NULL, last_status_update = at_time;
END;
$$;
REVOKE ALL ON FUNCTION public.reset_test_plantao(date, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_test_plantao(date, boolean, timestamptz) TO anon, authenticated;
