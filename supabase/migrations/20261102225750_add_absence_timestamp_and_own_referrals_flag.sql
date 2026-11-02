/*
# Add absence timestamp and own-referrals-only flag to brokers

1. Modified table: `brokers`
- `absence_started_at` (timestamptz, nullable): moment the broker left Presente for Pausa or Ausente. Cleared when the broker returns to Presente.
- `only_own_referrals` (boolean, not null, default false): set when a broker has been away for more than 2 hours in the current shift. While true, the broker receives only clients who arrive as their own direct referrals. Cleared at shift transition and plantão restart.

2. Security
- No new tables. Existing brokers policies and grants are unchanged; the new columns inherit the table's current access.

3. Notes
- Idempotent: safe to re-run.
- No existing data is modified or removed.
*/

ALTER TABLE brokers ADD COLUMN IF NOT EXISTS absence_started_at timestamptz;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS only_own_referrals boolean NOT NULL DEFAULT false;
