\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE anon;

-- Startup after both draw windows, with no enrolled broker: empty legacy markers.
DO $$
DECLARE
  empty_draw jsonb := '{"viva":[],"nobre":[],"inverse":[],"firstAgency":"Viva Imóveis"}';
  action_name text;
BEGIN
  FOREACH action_name IN ARRAY ARRAY['morning', 'morning_activate', 'afternoon', 'activate'] LOOP
    PERFORM public.apply_shift_schedule('2040-01-23', action_name, empty_draw);
  END LOOP;
END $$;

INSERT INTO public.brokers (id, operational_name, agency, equipe, presence_status, attendance_status,
  shift, arrived_at, afternoon_enrolled_at) VALUES
  ('10000000-0000-0000-0000-000000000011', 'Didi', 'Viva Imóveis', 'A', 'presente', 'livre',
    'manha', '2040-01-23T08:30:00-03:00', '2040-01-23T13:10:00-03:00'),
  ('10000000-0000-0000-0000-000000000012', 'He-Man', 'Casa Nobre', 'B', 'presente', 'livre',
    'manha', '2040-01-23T08:30:00-03:00', '2040-01-23T13:10:00-03:00');

DO $$
DECLARE
  completed_draw jsonb := '{"viva":["10000000-0000-0000-0000-000000000011"],
    "nobre":["10000000-0000-0000-0000-000000000012"],
    "inverse":["10000000-0000-0000-0000-000000000012","10000000-0000-0000-0000-000000000011"],
    "firstAgency":"Viva Imóveis"}';
  action_name text;
BEGIN
  FOREACH action_name IN ARRAY ARRAY['morning', 'afternoon'] LOOP
    PERFORM public.apply_shift_schedule('2040-01-23', action_name, completed_draw);
    -- Another caller must not overwrite the first nonempty draw.
    PERFORM public.apply_shift_schedule('2040-01-23', action_name,
      jsonb_set(completed_draw, '{firstAgency}', '"Casa Nobre"'));
    IF (SELECT schedule_data FROM public.plantao_sessions
      WHERE id = 'schedule_2040-01-23_' || action_name) IS DISTINCT FROM completed_draw THEN
      RAISE EXCEPTION 'Sorteio % vazio ou refeito indevidamente.', action_name;
    END IF;
  END LOOP;
  PERFORM public.apply_shift_schedule('2040-01-23', 'morning_activate', completed_draw);
  IF (SELECT count(*) FROM public.brokers WHERE id IN
    ('10000000-0000-0000-0000-000000000011','10000000-0000-0000-0000-000000000012')
    AND shift = 'manha' AND sorteio_order = 1) <> 2 THEN
    RAISE EXCEPTION 'Ativação vazia anterior bloqueou a manhã.';
  END IF;
  PERFORM public.apply_shift_schedule('2040-01-23', 'activate', completed_draw);
  IF (SELECT count(*) FROM public.brokers WHERE id IN
    ('10000000-0000-0000-0000-000000000011','10000000-0000-0000-0000-000000000012')
    AND shift = 'tarde' AND sorteio_order = 1) <> 2 THEN
    RAISE EXCEPTION 'Ativação vazia anterior bloqueou a tarde.';
  END IF;
  IF (SELECT count(*) FROM public.plantao_sessions WHERE plantao_date = '2040-01-23'
    AND schedule_data = completed_draw) <> 4 THEN
    RAISE EXCEPTION 'Sorteios e ativações não foram recuperados.';
  END IF;
END $$;
ROLLBACK;
