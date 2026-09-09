import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Agency = 'Viva Imóveis' | 'Casa Nobre';
export type VisitReason = 'Primeira visita' | 'Retorno' | 'Indicação' | 'Parceria' | 'Decorado';
export type BrokerPresence = 'ausente' | 'presente' | 'pausa';
export type AttendanceStatus = 'livre' | 'em_mesa' | 'decorado' | 'encerrado';

export type Broker = {
  id: string;
  operational_name: string;
  agency: Agency;
  presence_status: BrokerPresence;
  attendance_status: AttendanceStatus;
  arrived_at: string | null;
  last_status_update: string;
};

export type Visit = {
  id: string;
  customer_name: string;
  phone: string;
  visit_reason: VisitReason;
  referred_broker_id: string | null;
  status: 'aguardando' | 'aguardando_chamada' | 'em_atendimento' | 'encerrado' | 'recusado';
  created_at: string;
};

export type QueueEntry = {
  id: string;
  visit_id: string;
  broker_id: string | null;
  agency: Agency;
  queue_status: 'aguardando' | 'chamando' | 'ausente' | 'em_atendimento' | 'concluido';
  attempts: number;
  called_at: string | null;
  reentry_at: string | null;
  created_at: string;
  visit?: Visit;
  broker?: Broker;
};
