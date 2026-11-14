ALTER TABLE public.brokers
  ADD COLUMN IF NOT EXISTS pause_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS pause_exit_index integer,
  ADD COLUMN IF NOT EXISTS pause_exit_order bigint,
  ADD COLUMN IF NOT EXISTS pause_inverse_order bigint,
  ADD COLUMN IF NOT EXISTS pause_direct_snapshot uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS pause_scope text,
  ADD COLUMN IF NOT EXISTS manager_excused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS only_own_referrals boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS restriction_reason text CHECK (restriction_reason IN ('pause','late')),
  ADD COLUMN IF NOT EXISTS restriction_scope text;

-- Preserve the restriction on rows created before this migration.
UPDATE public.brokers SET only_own_referrals = true, restriction_reason = 'late',
  restriction_scope = coalesce((arrived_at AT TIME ZONE 'America/Sao_Paulo')::date::text,current_date::text) || ':' || coalesce(shift,'manha'),
  sorteio_order = NULL, inverse_order = NULL, merit_priority_return = false
WHERE attendance_status = 'apenas_indicacao';

CREATE TABLE public.pause_audit (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  broker_id uuid NOT NULL REFERENCES public.brokers(id),
  event text NOT NULL CHECK (event IN ('evasion','excuse')),
  scope text NOT NULL, pause_started_at timestamptz NOT NULL, occurred_at timestamptz NOT NULL,
  manager_name text,
  CHECK (event <> 'excuse' OR length(trim(manager_name)) > 0),
  UNIQUE (broker_id,pause_started_at,event)
);
ALTER TABLE public.pause_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY pause_audit_read ON public.pause_audit FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY pause_audit_insert ON public.pause_audit FOR INSERT TO anon,authenticated WITH CHECK (true);
GRANT SELECT,INSERT ON public.pause_audit TO anon,authenticated;

CREATE OR REPLACE FUNCTION public.guard_own_referrals()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- A valid new shift starts a new eligibility period.
  IF NEW.shift IS NOT NULL AND NEW.shift IS DISTINCT FROM OLD.shift THEN
    NEW.only_own_referrals := false;
    NEW.restriction_reason := NULL;
    NEW.restriction_scope := NULL;
    NEW.pause_started_at := NULL;
    NEW.pause_scope := NULL;
    NEW.manager_excused := false;
  END IF;
  IF NEW.presence_status = 'pausa' AND OLD.presence_status <> 'pausa' AND NEW.pause_started_at IS NULL THEN
    NEW.pause_started_at := NEW.last_status_update;
    NEW.pause_exit_order := OLD.sorteio_order;
    NEW.pause_inverse_order := OLD.inverse_order;
    SELECT coalesce(array_agg(id ORDER BY sorteio_order,id),'{}') INTO NEW.pause_direct_snapshot FROM brokers
      WHERE agency = NEW.agency AND shift IS NOT DISTINCT FROM NEW.shift AND NOT is_external_partner
        AND sorteio_order IS NOT NULL AND NOT only_own_referrals AND presence_status = 'presente';
    NEW.pause_exit_index := coalesce(array_position(NEW.pause_direct_snapshot,NEW.id),0);
    NEW.pause_scope := (NEW.pause_started_at AT TIME ZONE 'America/Sao_Paulo')::date::text || ':' || coalesce(NEW.shift,'manha');
    NEW.manager_excused := false;
  END IF;
  IF NEW.only_own_referrals THEN
    NEW.sorteio_order := NULL;
    NEW.inverse_order := NULL;
    NEW.merit_priority_return := false;
    NEW.returning_from_pause := false;
    IF NEW.attendance_status = 'livre' THEN NEW.attendance_status := 'apenas_indicacao'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- Runs after the Stage 2 completion trigger and preserves the restriction after conclude.
CREATE TRIGGER zz_guard_own_referrals BEFORE UPDATE ON public.brokers
FOR EACH ROW EXECUTE FUNCTION public.guard_own_referrals();

CREATE OR REPLACE FUNCTION public.apply_pause_action(
  target_id uuid, action text, at_time timestamptz, shift_name text, manager_name text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  b brokers%ROWTYPE;
  scope_key text := (at_time AT TIME ZONE 'America/Sao_Paulo')::date::text || ':' || shift_name;
  cutoff time := CASE WHEN shift_name = 'tarde' THEN '14:30:00'::time ELSE '09:30:00'::time END;
  line uuid[]; head brokers%ROWTYPE; head_index integer; insert_index integer; next_id uuid;
  expired boolean; passed boolean; restricted boolean; position integer; saved_start timestamptz;
BEGIN
  IF action NOT IN ('pause','return','excuse','checkin','expire') OR shift_name NOT IN ('manha','tarde') THEN RAISE EXCEPTION 'Invalid pause action'; END IF;
  SELECT * INTO STRICT b FROM brokers WHERE id = target_id;
  IF b.is_external_partner THEN RAISE EXCEPTION 'External partners use a separate flow'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pause_company_' || b.agency));
  PERFORM id FROM brokers WHERE agency = b.agency ORDER BY id FOR UPDATE;
  SELECT * INTO STRICT b FROM brokers WHERE id = target_id;

  IF action = 'pause' THEN
    IF b.pause_started_at IS NOT NULL AND b.presence_status = 'pausa' THEN RETURN; END IF;
    IF b.presence_status <> 'presente' THEN RAISE EXCEPTION 'Register presence before pausing'; END IF;
    IF b.attendance_status IN ('em_mesa','em_atendimento','decorado') THEN RAISE EXCEPTION 'Finish service before pausing'; END IF;
    SELECT coalesce(array_agg(id ORDER BY sorteio_order,id),'{}') INTO line FROM brokers
      WHERE agency = b.agency AND shift IS NOT DISTINCT FROM b.shift AND NOT is_external_partner
      AND sorteio_order IS NOT NULL AND NOT only_own_referrals AND attendance_status <> 'apenas_indicacao' AND presence_status = 'presente';
    UPDATE brokers SET presence_status = 'pausa', pause_started_at = at_time,
      pause_exit_index = coalesce(array_position(line,target_id),0), pause_exit_order = sorteio_order,
      pause_inverse_order = inverse_order, pause_direct_snapshot = line, pause_scope = scope_key,
      manager_excused = false, last_status_update = at_time WHERE id = target_id;
    RETURN;
  END IF;

  IF action = 'excuse' THEN
    IF manager_name IS NULL OR trim(manager_name) = '' THEN RAISE EXCEPTION 'Manager name required'; END IF;
    IF b.pause_scope IS DISTINCT FROM scope_key THEN RAISE EXCEPTION 'Excuse must belong to the current shift'; END IF;
    saved_start := b.pause_started_at;
    IF saved_start IS NULL THEN
      SELECT pause_started_at INTO saved_start FROM pause_audit
        WHERE broker_id = target_id AND pause_audit.scope = scope_key AND event = 'evasion' ORDER BY occurred_at DESC LIMIT 1;
    END IF;
    IF saved_start IS NULL THEN RAISE EXCEPTION 'No pause to excuse'; END IF;
    INSERT INTO pause_audit(broker_id,event,scope,pause_started_at,occurred_at,manager_name)
      VALUES(target_id,'excuse',scope_key,saved_start,at_time,trim(manager_name)) ON CONFLICT DO NOTHING;
    b.pause_started_at := saved_start;
    b.manager_excused := true;
    UPDATE brokers SET manager_excused = true WHERE id = target_id;
  END IF;

  expired := b.pause_started_at IS NOT NULL AND b.pause_scope = scope_key AND NOT b.manager_excused
    AND at_time - b.pause_started_at > interval '120 minutes';
  IF expired THEN
    INSERT INTO pause_audit(broker_id,event,scope,pause_started_at,occurred_at)
      VALUES(target_id,'evasion',scope_key,b.pause_started_at,at_time) ON CONFLICT DO NOTHING;
    UPDATE brokers SET only_own_referrals = true, restriction_reason = CASE WHEN restriction_reason = 'late' THEN 'late' ELSE 'pause' END,
      restriction_scope = scope_key, sorteio_order = NULL, inverse_order = NULL, merit_priority_return = false,
      returning_from_pause = false, attendance_status = 'apenas_indicacao' WHERE id = target_id;
    IF action IN ('return','checkin') THEN
      UPDATE brokers SET presence_status = 'presente', pause_started_at = NULL, last_status_update = at_time WHERE id = target_id;
    END IF;
    RETURN;
  END IF;
  IF action = 'expire' THEN RETURN; END IF;

  IF b.pause_started_at IS NOT NULL AND b.pause_scope = scope_key THEN
    IF b.restriction_reason = 'late' OR (b.only_own_referrals AND b.restriction_scope = scope_key AND NOT b.manager_excused) THEN
      UPDATE brokers SET presence_status = 'presente', pause_started_at = NULL, attendance_status = 'apenas_indicacao', last_status_update = at_time WHERE id = target_id;
      RETURN;
    END IF;
    SELECT coalesce(array_agg(id ORDER BY sorteio_order,id),'{}') INTO line FROM brokers
      WHERE agency = b.agency AND shift IS NOT DISTINCT FROM b.shift AND NOT is_external_partner
        AND id <> target_id AND sorteio_order IS NOT NULL AND NOT only_own_referrals AND attendance_status <> 'apenas_indicacao';
    SELECT * INTO head FROM brokers WHERE id = ANY(line) AND presence_status = 'presente' AND attendance_status = 'livre'
      ORDER BY sorteio_order,id LIMIT 1;
    head_index := coalesce(array_position(b.pause_direct_snapshot,head.id),0);
    passed := head.id IS NOT NULL AND (head_index >= b.pause_exit_index - 1 OR head.sorteio_order > b.pause_exit_order);
    IF NOT coalesce(passed,false) AND b.sorteio_order IS NOT NULL THEN
      UPDATE brokers SET presence_status = 'presente', attendance_status = 'livre', pause_started_at = NULL,
        only_own_referrals = false, restriction_reason = NULL, restriction_scope = NULL,
        inverse_order = coalesce(b.pause_inverse_order,b.inverse_order), merit_priority_return = false,
        returning_from_pause = false, last_status_update = at_time WHERE id = target_id;
      RETURN;
    END IF;
    IF passed THEN insert_index := array_position(line,head.id);
    ELSE
      SELECT value INTO next_id FROM unnest(b.pause_direct_snapshot) WITH ORDINALITY AS snapshot(value,ordinality)
        WHERE ordinality > b.pause_exit_index AND value = ANY(line) ORDER BY ordinality LIMIT 1;
      insert_index := CASE WHEN next_id IS NOT NULL THEN array_position(line,next_id) - 1
        ELSE least(greatest(coalesce(b.pause_exit_index,1)-1,0),cardinality(line)) END;
    END IF;
    line := line[1:insert_index] || ARRAY[target_id] || line[insert_index+1:cardinality(line)];
    -- Release the restriction and reindex atomically, without advancing any company pointer.
    UPDATE brokers SET presence_status = 'presente', attendance_status = 'livre', pause_started_at = NULL,
      only_own_referrals = false, restriction_reason = NULL, restriction_scope = NULL,
      inverse_order = coalesce(b.pause_inverse_order,b.inverse_order), merit_priority_return = false,
      returning_from_pause = false, last_status_update = at_time WHERE id = target_id;
    FOR position IN 1..cardinality(line) LOOP UPDATE brokers SET sorteio_order = position WHERE id = line[position]; END LOOP;
    RETURN;
  END IF;

  IF action = 'return' THEN RETURN; END IF;
  IF b.presence_status = 'presente' AND b.arrived_at IS NOT NULL AND b.shift = shift_name AND (b.arrived_at AT TIME ZONE 'America/Sao_Paulo')::date = (at_time AT TIME ZONE 'America/Sao_Paulo')::date THEN RETURN; END IF;
  restricted := (b.only_own_referrals AND b.restriction_scope = scope_key) OR (at_time AT TIME ZONE 'America/Sao_Paulo')::time > cutoff;
  UPDATE brokers SET shift = shift_name, arrived_at = at_time, pause_started_at = NULL, pause_scope = NULL,
    sorteio_order = CASE WHEN b.shift IS DISTINCT FROM shift_name OR (b.arrived_at AT TIME ZONE 'America/Sao_Paulo')::date IS DISTINCT FROM (at_time AT TIME ZONE 'America/Sao_Paulo')::date THEN NULL ELSE sorteio_order END,
    inverse_order = CASE WHEN b.shift IS DISTINCT FROM shift_name OR (b.arrived_at AT TIME ZONE 'America/Sao_Paulo')::date IS DISTINCT FROM (at_time AT TIME ZONE 'America/Sao_Paulo')::date THEN NULL ELSE inverse_order END
    WHERE id = target_id;
  UPDATE brokers SET presence_status = 'presente', only_own_referrals = coalesce(restricted,false),
    restriction_reason = CASE WHEN restricted THEN CASE WHEN b.restriction_scope = scope_key THEN coalesce(b.restriction_reason,'late') ELSE 'late' END ELSE NULL END,
    restriction_scope = CASE WHEN restricted THEN scope_key ELSE NULL END,
    attendance_status = CASE WHEN restricted THEN 'apenas_indicacao' ELSE 'livre' END,
    sorteio_order = CASE WHEN restricted THEN NULL ELSE coalesce(sorteio_order,
      (SELECT coalesce(max(other.sorteio_order),0)+1 FROM brokers other WHERE other.agency=b.agency AND other.shift=shift_name)) END,
    inverse_order = CASE WHEN restricted THEN NULL ELSE coalesce(inverse_order,(SELECT coalesce(max(other.inverse_order),0)+1 FROM brokers other)) END,
    merit_priority_return = false, last_status_update = at_time WHERE id = target_id;
END;
$$;

CREATE TABLE public.external_partner_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_name text NOT NULL CHECK(length(trim(partner_name))>0),
  company text NOT NULL DEFAULT 'Autônomo' CHECK(length(trim(company))>0), creci text NOT NULL CHECK(length(trim(creci))>0),
  client_first_name text NOT NULL CHECK(length(trim(client_first_name))>0 AND client_first_name !~ '\s'),
  arrival text NOT NULL CHECK(arrival IN ('before_partner','accompanied')),
  manager_target text NOT NULL CHECK(manager_target IN ('partnerships','general')),
  manager_status text NOT NULL DEFAULT 'pending' CHECK(manager_status IN ('pending','acknowledged')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.external_partner_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), intake_id uuid NOT NULL UNIQUE REFERENCES external_partner_intakes(id),
  unit_reference text NOT NULL CHECK(length(trim(unit_reference))>0), commission_percent integer NOT NULL DEFAULT 100 CHECK(commission_percent=100),
  customer_full_name text, customer_phone text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.external_partner_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_partner_reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_intakes_read ON external_partner_intakes FOR SELECT TO anon,authenticated USING(true);
CREATE POLICY partner_intakes_insert ON external_partner_intakes FOR INSERT TO anon,authenticated WITH CHECK(true);
CREATE POLICY partner_intakes_update ON external_partner_intakes FOR UPDATE TO anon,authenticated USING(true) WITH CHECK(true);
CREATE POLICY partner_reservations_read ON external_partner_reservations FOR SELECT TO anon,authenticated USING(true);
CREATE POLICY partner_reservations_insert ON external_partner_reservations FOR INSERT TO anon,authenticated WITH CHECK(true);
CREATE POLICY partner_reservations_update ON external_partner_reservations FOR UPDATE TO anon,authenticated USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON external_partner_intakes,external_partner_reservations TO anon,authenticated;
CREATE OR REPLACE FUNCTION public.reserve_partner_unit(intake uuid, unit text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE reservation external_partner_reservations%ROWTYPE;
BEGIN
  IF unit IS NULL OR trim(unit) = '' THEN RAISE EXCEPTION 'Unit reservation required'; END IF;
  PERFORM id FROM external_partner_intakes WHERE id=intake FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partner intake not found'; END IF;
  INSERT INTO external_partner_reservations(intake_id,unit_reference) VALUES(intake,trim(unit)) ON CONFLICT(intake_id) DO NOTHING;
  SELECT * INTO reservation FROM external_partner_reservations WHERE intake_id=intake;
  RETURN to_jsonb(reservation);
END;
$$;
