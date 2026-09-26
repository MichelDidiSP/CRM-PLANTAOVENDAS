-- Add 'apenas_indicacao' to attendance_status CHECK constraint
ALTER TABLE brokers DROP CONSTRAINT IF EXISTS brokers_attendance_status_check;
ALTER TABLE brokers ADD CONSTRAINT brokers_attendance_status_check
  CHECK (attendance_status IN ('livre', 'em_mesa', 'decorado', 'encerrado', 'parceiro', 'apenas_indicacao'));