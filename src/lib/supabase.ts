import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Agency = 'Viva Imóveis' | 'Casa Nobre' | 'Externo';
export type VisitReason = 'Primeira visita' | 'Retorno' | 'Indicação' | 'Parceria' | 'Visita ao Decorado';
export type BrokerPresence = 'ausente' | 'presente' | 'pausa';
export type AttendanceStatus = 'livre' | 'em_mesa' | 'decorado' | 'encerrado' | 'parceiro';
export type QueueType = 'geral' | 'decorado' | 'parceria';

export type Broker = {
  id: string;
  operational_name: string;
  agency: Agency;
  presence_status: BrokerPresence;
  attendance_status: AttendanceStatus;
  arrived_at: string | null;
  last_status_update: string;
  is_external_partner: boolean;
  external_company: string | null;
  sorteio_order: number | null;
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
  queue_type: QueueType;
  sorteio_session: string | null;
  created_at: string;
  updated_at: string;
  visit?: Visit;
  broker?: Broker;
};

export type PlantaoSession = {
  id: string;
  started_at: string;
  ended_at: string | null;
  status: 'active' | 'ended';
};
