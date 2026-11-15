-- Visits are events: a telephone may have multiple visits and may be declined.
ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_phone_key;
ALTER TABLE public.visits ALTER COLUMN phone DROP NOT NULL;
UPDATE public.visits SET phone = nullif(regexp_replace(phone, '\D', '', 'g'), '');
CREATE INDEX IF NOT EXISTS visits_phone_history ON public.visits(phone, created_at);
CREATE OR REPLACE FUNCTION public.normalize_visit_phone() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.phone := nullif(regexp_replace(NEW.phone, '\D', '', 'g'), '');
  IF NEW.phone IS NULL THEN
    NEW.visit_reason := 'Visita ao Decorado';
    NEW.referred_broker_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER normalize_visit_phone BEFORE INSERT OR UPDATE OF phone ON public.visits
FOR EACH ROW EXECUTE FUNCTION public.normalize_visit_phone();

-- Capture names and the applied coverage rule at assignment time for historical reporting.
ALTER TABLE public.queue_entries
  ADD COLUMN original_broker_name text,
  ADD COLUMN attending_broker_name text,
  ADD COLUMN applied_rule text;
CREATE OR REPLACE FUNCTION public.capture_attendance_trace() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE owner_id uuid; owner public.brokers%ROWTYPE; actual public.brokers%ROWTYPE; pre_assignee uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.broker_id IS NOT DISTINCT FROM OLD.broker_id THEN RETURN NEW; END IF;
  END IF;
  SELECT referred_broker_id, pre_opening_assignee INTO owner_id, pre_assignee FROM visits WHERE id = NEW.visit_id;
  SELECT * INTO owner FROM brokers WHERE id = owner_id;
  SELECT * INTO actual FROM brokers WHERE id = NEW.broker_id;
  NEW.original_broker_name := owner.operational_name;
  NEW.attending_broker_name := actual.operational_name;
  NEW.applied_rule := CASE
    WHEN NEW.broker_id IS NULL THEN NULL
    WHEN owner_id IS NULL THEN CASE WHEN NEW.queue_type = 'decorado' THEN 'Fila Inversa' ELSE 'Vez Geral' END
    WHEN owner_id = NEW.broker_id THEN 'Corretor próprio'
    WHEN pre_assignee = NEW.broker_id THEN 'Primeiro inscrito da Empresa (pré-plantão)'
    WHEN owner.agency = actual.agency AND owner.equipe IS NOT NULL AND owner.equipe = actual.equipe THEN 'Último da Equipe'
    ELSE 'Último da Empresa' END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_attendance_trace BEFORE INSERT OR UPDATE OF broker_id ON public.queue_entries
FOR EACH ROW EXECUTE FUNCTION public.capture_attendance_trace();
