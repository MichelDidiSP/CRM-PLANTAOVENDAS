/*
# Add 'aguardando_chamada' visit status

1. Changes
- Alter the `status` CHECK constraint on `visits` to include 'aguardando_chamada'.
- This status represents the moment a client has been called but the broker hasn't
  confirmed presence yet (the TV timer is running).

2. Security
- No RLS changes; existing policies remain valid.

3. Notes
- No data is lost; existing rows keep their current status values.
*/

ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_status_check;

ALTER TABLE public.visits ADD CONSTRAINT visits_status_check
  CHECK (status IN ('aguardando', 'aguardando_chamada', 'em_atendimento', 'encerrado', 'recusado'));
