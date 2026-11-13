-- Continuity uses the same in-service status already emitted by the UI.
ALTER TABLE public.brokers DROP CONSTRAINT IF EXISTS brokers_attendance_status_check;
ALTER TABLE public.brokers ADD CONSTRAINT brokers_attendance_status_check
  CHECK (attendance_status IN ('livre', 'em_mesa', 'decorado', 'encerrado', 'parceiro', 'apenas_indicacao', 'em_atendimento'));

ALTER TABLE public.brokers
  ADD COLUMN IF NOT EXISTS afternoon_enrolled_at timestamptz,
  ADD COLUMN IF NOT EXISTS preserve_shift_position boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS leave_after_service boolean NOT NULL DEFAULT false;
ALTER TABLE public.plantao_sessions ADD COLUMN IF NOT EXISTS schedule_data jsonb;

-- Preserve the afternoon draw when a carried-over service finishes.
CREATE OR REPLACE FUNCTION public.finish_shift_service()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.preserve_shift_position AND NEW.attendance_status = 'livre'
     AND OLD.attendance_status IN ('em_atendimento', 'em_mesa', 'decorado') THEN
    NEW.sorteio_order := OLD.sorteio_order;
    NEW.inverse_order := OLD.inverse_order;
    NEW.preserve_shift_position := false;
  END IF;
  IF OLD.leave_after_service AND NEW.attendance_status = 'livre' THEN
    NEW.presence_status := 'ausente';
    NEW.sorteio_order := NULL;
    NEW.inverse_order := NULL;
    NEW.leave_after_service := false;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finish_shift_service BEFORE UPDATE ON public.brokers
FOR EACH ROW EXECUTE FUNCTION public.finish_shift_service();

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
  IF EXISTS (SELECT 1 FROM plantao_sessions WHERE id = event_id) THEN RETURN; END IF;
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
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS pre_opening_assignee uuid REFERENCES public.brokers(id) ON DELETE SET NULL;
