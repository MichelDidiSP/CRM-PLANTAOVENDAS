-- Preserve the official schedule transaction; permit an empty draw marker to be completed.
CREATE OR REPLACE FUNCTION public.apply_shift_schedule(day date, action text, draw jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  event_id text := 'schedule_' || day::text || '_' || action;
  b brokers%ROWTYPE;
  direct_rank integer;
  inverse_rank integer;
  busy boolean;
  valid boolean;
BEGIN
  IF action NOT IN ('morning', 'morning_activate', 'afternoon', 'activate', 'close') THEN RAISE EXCEPTION 'Invalid schedule action'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('shift_schedule_' || day::text));
  IF EXISTS (SELECT 1 FROM plantao_sessions WHERE id = event_id) THEN
    -- A startup with no enrolled brokers creates an empty marker. Only that
    -- marker may be replaced; the day lock keeps a real draw immutable even
    -- when reception and audit request it concurrently.
    IF action = 'close'
      OR coalesce(jsonb_array_length(draw -> 'viva'), 0) + coalesce(jsonb_array_length(draw -> 'nobre'), 0) = 0
      OR EXISTS (SELECT 1 FROM plantao_sessions WHERE id = event_id
        AND coalesce(jsonb_array_length(schedule_data -> 'viva'), 0)
          + coalesce(jsonb_array_length(schedule_data -> 'nobre'), 0) > 0)
    THEN RETURN; END IF;
    DELETE FROM plantao_sessions WHERE id = event_id;
  END IF;
  IF action = 'morning_activate' THEN
    SELECT schedule_data INTO draw FROM plantao_sessions WHERE id = 'schedule_' || day::text || '_morning';
    IF draw IS NULL THEN RAISE EXCEPTION 'Morning draw missing'; END IF;
    FOR b IN SELECT * FROM brokers WHERE shift = 'manha' AND NOT is_external_partner
      AND presence_status <> 'ausente' AND arrived_at IS NOT NULL ORDER BY arrived_at, id LOOP
      IF NOT (draw -> 'inverse') @> to_jsonb(ARRAY[b.id::text]) THEN
        draw := jsonb_set(draw, ARRAY[CASE WHEN b.agency = 'Viva Imóveis' THEN 'viva' ELSE 'nobre' END],
          (draw -> CASE WHEN b.agency = 'Viva Imóveis' THEN 'viva' ELSE 'nobre' END) || to_jsonb(b.id::text));
        draw := jsonb_set(draw, '{inverse}', (draw -> 'inverse') || to_jsonb(b.id::text));
      END IF;
    END LOOP;
    UPDATE plantao_sessions SET schedule_data = draw WHERE id = 'schedule_' || day::text || '_morning';
  END IF;
  IF action = 'activate' THEN
    SELECT schedule_data INTO draw FROM plantao_sessions WHERE id = 'schedule_' || day::text || '_afternoon';
    IF draw IS NULL THEN RAISE EXCEPTION 'Afternoon draw missing'; END IF;
  END IF;
  IF action IN ('morning_activate', 'activate') THEN
    FOR b IN SELECT * FROM brokers WHERE NOT is_external_partner FOR UPDATE LOOP
      SELECT ordinality::integer INTO direct_rank
      FROM jsonb_array_elements_text(draw -> CASE WHEN b.agency = 'Viva Imóveis' THEN 'viva' ELSE 'nobre' END) WITH ORDINALITY
      WHERE value = b.id::text;
      SELECT ordinality::integer INTO inverse_rank FROM jsonb_array_elements_text(draw -> 'inverse') WITH ORDINALITY WHERE value = b.id::text;
      busy := b.attendance_status IN ('em_atendimento', 'em_mesa', 'decorado');
      valid := direct_rank IS NOT NULL AND (b.afternoon_enrolled_at AT TIME ZONE 'America/Sao_Paulo')::date = day
        AND (b.afternoon_enrolled_at AT TIME ZONE 'America/Sao_Paulo')::time BETWEEN '13:00:00' AND '13:45:59';
      IF action = 'morning_activate' AND direct_rank IS NOT NULL THEN
        UPDATE brokers SET sorteio_order = direct_rank, inverse_order = inverse_rank, shift = 'manha', preserve_shift_position = busy WHERE id = b.id;
      ELSIF action = 'activate' AND valid THEN
        UPDATE brokers SET sorteio_order = direct_rank, inverse_order = inverse_rank, shift = 'tarde',
          arrived_at = afternoon_enrolled_at, preserve_shift_position = busy, afternoon_reserved = false WHERE id = b.id;
        UPDATE queue_entries SET shift = 'tarde' WHERE broker_id = b.id AND queue_status IN ('chamando', 'em_atendimento');
      ELSIF action = 'activate' THEN
        UPDATE brokers SET sorteio_order = NULL, inverse_order = NULL, shift = NULL,
          presence_status = CASE WHEN busy THEN presence_status ELSE 'ausente' END, leave_after_service = busy WHERE id = b.id;
      END IF;
    END LOOP;
    IF action = 'activate' THEN
      INSERT INTO relatorio_fechamento (shift, snapshot_data, total_attendances)
        SELECT 'manha', coalesce(jsonb_agg(to_jsonb(q)), '[]'), count(*) FROM queue_entries q WHERE shift = 'manha' AND queue_status = 'concluido';
      UPDATE queue_entries SET shift = 'tarde' WHERE shift = 'manha' AND queue_status = 'aguardando';
    END IF;
    UPDATE plantao_sessions SET status = 'ended', ended_at = now() WHERE status = 'active';
  END IF;
  IF action = 'close' THEN
    UPDATE brokers SET leave_after_service = true WHERE attendance_status IN ('em_atendimento', 'em_mesa', 'decorado');
    UPDATE brokers SET presence_status = 'ausente', sorteio_order = NULL, inverse_order = NULL
      WHERE attendance_status NOT IN ('em_atendimento', 'em_mesa', 'decorado');
    UPDATE plantao_sessions SET status = 'ended', ended_at = now() WHERE status = 'active';
  END IF;
  INSERT INTO plantao_sessions (id, plantao_date, shift, status, schedule_data)
    VALUES (event_id, day, CASE WHEN action LIKE 'morning%' THEN 'manha' ELSE 'tarde' END,
      CASE WHEN action IN ('morning_activate', 'activate') THEN 'active' ELSE 'ended' END, draw);
END;
$$;