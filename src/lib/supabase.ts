import { createClient } from '@supabase/supabase-js';
import { createMockClient } from './mockClient';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

const realClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});
const mockClient = createMockClient();

let usingMock = false;
let probePromise: Promise<boolean> | null = null;

function probeReal(): Promise<boolean> {
  if (probePromise) return probePromise;
  probePromise = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 4000);
    realClient
      .from('brokers')
      .select('id')
      .limit(1)
      .then(() => { clearTimeout(timeout); resolve(true); })
      .catch(() => { clearTimeout(timeout); resolve(false); });
  });
  return probePromise;
}

const handler: ProxyHandler<typeof realClient> = {
  get(_target, prop) {
    if (usingMock) return (mockClient as any)[prop];
    return (realClient as any)[prop];
  },
};

export const supabase = new Proxy(realClient, handler) as typeof realClient;

export const dbReady = probeReal().then((ok) => {
  if (!ok) {
    usingMock = true;
    console.warn('Supabase indisponível — usando banco de dados local em memória.');
  }
  return !usingMock;
});

export type Agency = 'Viva Imóveis' | 'Casa Nobre' | 'Externo';
export type VisitReason = 'Primeira visita' | 'Retorno' | 'Indicação' | 'Parceria' | 'Visita ao Decorado' | 'Indicação Presente' | 'Indicação Ausente' | 'Indicação Imobiliária';
export type BrokerPresence = 'ausente' | 'presente' | 'pausa';
export type AttendanceStatus = 'livre' | 'em_mesa' | 'decorado' | 'encerrado' | 'parceiro';
export type QueueType = 'geral' | 'decorado' | 'parceria';
export type Shift = 'manha' | 'tarde';

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
  shift: Shift | null;
  afternoon_reserved: boolean;
  created_at: string;
};

export type Visit = {
  id: string;
  customer_name: string;
  phone: string;
  visit_reason: VisitReason;
  referred_broker_id: string | null;
  status: 'aguardando' | 'aguardando_chamada' | 'em_atendimento' | 'encerrado' | 'recusado';
  created_at: string;
  updated_at: string;
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
  shift: Shift | null;
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
  shift: Shift | null;
  plantao_date: string | null;
  last_called_agency: Agency | null;
};
