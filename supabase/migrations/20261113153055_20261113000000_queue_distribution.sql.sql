-- Reentry ranks use the exact completion-click timestamp in milliseconds.
ALTER TABLE public.brokers
  ADD COLUMN IF NOT EXISTS merit_priority_return boolean NOT NULL DEFAULT false,
  ALTER COLUMN sorteio_order TYPE bigint,
  ALTER COLUMN inverse_order TYPE bigint;

-- Complete all three records atomically and make repeated clicks idempotent.
CREATE OR REPLACE FUNCTION public.conclude_queue_attendance(entry_id uuid, clicked_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  entry queue_entries%ROWTYPE;
  reason text;
  rank bigint := floor(extract(epoch FROM clicked_at) * 1000);
BEGIN
  SELECT * INTO entry FROM queue_entries WHERE id = entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found'; END IF;
  IF entry.queue_status = 'concluido' THEN RETURN; END IF;
  SELECT visit_reason INTO reason FROM visits WHERE id = entry.visit_id;
  UPDATE brokers SET
    sorteio_order = CASE
      WHEN entry.queue_type = 'geral' AND (reason = 'Retorno' OR reason LIKE 'Indicação%')
        AND merit_priority_return THEN -rank
      WHEN entry.queue_type = 'geral' AND reason = 'Primeira visita' THEN rank
      ELSE sorteio_order END,
    inverse_order = CASE WHEN entry.queue_type = 'decorado' THEN rank ELSE inverse_order END,
    merit_priority_return = false,
    attendance_status = 'livre', last_status_update = clicked_at
  WHERE id = entry.broker_id;
  UPDATE visits SET status = 'encerrado' WHERE id = entry.visit_id;
  UPDATE queue_entries SET queue_status = 'concluido', updated_at = clicked_at WHERE id = entry_id;
END;
$$;