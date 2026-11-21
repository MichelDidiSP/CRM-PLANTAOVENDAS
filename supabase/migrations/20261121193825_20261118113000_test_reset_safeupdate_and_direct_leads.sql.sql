-- Keep all reset mutations explicit for pg-safeupdate. Historical migrations stay intact.
-- Explicit TESTE action. This flag expresses intent, not operator authentication.
CREATE OR REPLACE FUNCTION public.reset_test_plantao(day date, test_mode boolean, at_time timestamptz) RETURNS void
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
    only_own_referrals = false, restriction_reason = NULL, restriction_scope = NULL, last_status_update = at_time
    WHERE id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.reset_test_plantao(date, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_test_plantao(date, boolean, timestamptz) TO anon, authenticated;

-- Public read projection for TESTE only; the nominal operational table stays private.
-- The barrier keeps non-test rows outside the caller's query. No write grants.
CREATE OR REPLACE VIEW public.test_incorporadora_direct_leads WITH (security_barrier = true) AS
  SELECT l.id, l.customer_name, l.phone, l.created_at,
    (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS test_date
  FROM crm_private.incorporadora_direct_leads l
  WHERE l.is_test = true;
REVOKE ALL ON public.test_incorporadora_direct_leads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.test_incorporadora_direct_leads TO anon, authenticated;
NOTIFY pgrst, 'reload schema';