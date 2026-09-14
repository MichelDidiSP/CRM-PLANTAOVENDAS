/*
# Add Indicação Module 3 visit reasons

1. Constraint Changes
- visits.visit_reason: add three new values for the Indicação module:
  'Indicação Presente' — client knows the broker and broker is present
  'Indicação Ausente' — client knows the broker but broker is absent
  'Indicação Imobiliária' — client only knows the agency brand
- Existing 'Indicação' value remains for backward compatibility.

2. Notes
- Idempotent: safe to re-run.
- No data loss: existing rows with 'Indicação' are preserved.
*/

ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_visit_reason_check;
ALTER TABLE visits ADD CONSTRAINT visits_visit_reason_check CHECK (
  visit_reason IN (
    'Primeira visita',
    'Retorno',
    'Indicação',
    'Parceria',
    'Visita ao Decorado',
    'Indicação Presente',
    'Indicação Ausente',
    'Indicação Imobiliária'
  )
);