import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizePhone, maskPhone, completePhone, firstName, visitOwner, intakeRoute, lookupReturn, attendanceTrace, recentVisits } from './intake';
import { supabase, type Visit, type QueueEntry, type Broker } from '../supabase';
const visit = (id: string, phone: string | null, owner: string | null = null) => ({ id, phone, referred_broker_id: owner, customer_name: 'Maria Silva', created_at: `2026-11-${id === 'old' ? '10' : '15'}T12:00:00Z`, visit_reason: 'Primeira visita', status: 'encerrado' }) as Visit;
const entry = (id: string, broker = 'owner') => ({ id, visit_id: id, broker_id: broker, queue_status: 'concluido', created_at: '2026-11-10T12:00:00Z' }) as QueueEntry;
afterEach(() => vi.restoreAllMocks());
describe('Reception privacy and intake', () => {
  it.each([['(11) 91234-5678','11912345678'], ['11 3333-4444','1133334444'], [null,''],['','']])('normalizes %s', (input, expected) => expect(normalizePhone(input)).toBe(expected));
  it('masks mobile and landline without changing digits', () => { expect(maskPhone('11912345678')).toBe('(11) 91234-5678'); expect(maskPhone('1133334444')).toBe('(11) 3333-4444'); });
  it('waits for full mobile number and permits complete landline', () => { expect(completePhone('1191234567')).toBe(false); expect(completePhone('11912345678')).toBe(true); expect(completePhone('1133334444')).toBe(true); });
  it.each(['Maria da Silva', '  Maria\tSilva ', 'Maria'])('shows only first name of %s', name => expect(firstName(name)).toBe('Maria'));
  it('handles empty names', () => expect(firstName(null)).toBe('—'));
  it('finds old formatted records and the broker who served the first visit', () => expect(visitOwner([visit('old','(11) 91234-5678')],[entry('old')],'11912345678')?.ownerId).toBe('owner'));
  it('preserves the original broker when a substitute handled a referral', () => expect(visitOwner([visit('old','11912345678','original')],[entry('old','cover')],'11912345678')?.ownerId).toBe('original'));
  it('does not transfer ownership to the latest substitute', () => expect(visitOwner([visit('new','11912345678'),visit('old','11912345678')],[entry('new','cover'),entry('old')],'11912345678')?.ownerId).toBe('owner'));
  it('does not look up incomplete telephone or name', async () => { const query = vi.spyOn(supabase,'from'); expect(await lookupReturn('Maria Silva')).toBeNull(); expect(await lookupReturn('119123')).toBeNull(); expect(query).not.toHaveBeenCalled(); });
  it('queries pure digits and finds quick-entry history', async () => {
    await supabase.from('visits').insert(visit('quick-test','11987654321'));
    await supabase.from('queue_entries').insert(entry('quick-test'));
    try { expect((await lookupReturn('(11) 98765-4321'))?.ownerId).toBe('owner'); }
    finally { await supabase.from('queue_entries').delete().eq('id','quick-test'); await supabase.from('visits').delete().eq('id','quick-test'); }
  });
  it.each([['',false],['11912345678',true]])('routes no telephone to inverse with null telephone', (phone, declined) => expect(intakeRoute(phone as string,declined as boolean,'Primeira visita','owner',null)).toMatchObject({ phone:null, queue_type:'decorado', visit_reason:'Visita ao Decorado', referred_broker_id:null }));
  it('rejects partial telephone', () => expect(() => intakeRoute('11912',false,'Primeira visita',null,null)).toThrow());
  it('automatically routes a matched phone as return to its owner', () => expect(intakeRoute('(11) 91234-5678',false,'Primeira visita',null,{visit:visit('old','11912345678'),ownerId:'owner'})).toMatchObject({ phone:'11912345678', visit_reason:'Retorno', referred_broker_id:'owner', queue_type:'geral' }));
  it('does not match clients by name', () => expect(visitOwner([visit('old','11912345678')],[entry('old')],'11999999999')).toBeNull());
  it('limits recent records to five in descending time', () => expect(recentVisits(Array.from({length:9},(_,i)=>({...visit(String(i),'11912345678'),created_at:String(i)}))).map(v=>v.id)).toEqual(['8','7','6','5','4']));
  it('describes owner, actual broker and coverage rule', () => {
    const brokers = [{id:'original', operational_name:'Ana',agency:'Viva Imóveis', equipe:'A'},{id:'cover', operational_name:'João',agency:'Viva Imóveis', equipe:'A'}] as Broker[];
    const e = {...entry('old','cover'),visit:{...visit('old','11912345678','original'),visit_reason:'Retorno' as const}};
    expect(attendanceTrace(e,brokers)).toContain('Retorno · Corretor original: Ana · Corretor que atendeu: João · Último da Equipe');
    brokers[1].equipe='B'; expect(attendanceTrace(e,brokers)).toContain('Último da Empresa');
    e.queue_status='chamando'; expect(attendanceTrace(e,brokers)).toContain('Corretor designado');
  });
});

it('recovers the broker assigned by quick entry before the service is concluded', () => {
  const quick = { ...entry('old'), queue_status: 'chamando' as const };
  expect(visitOwner([visit('old','11912345678')],[quick],'11912345678')?.ownerId).toBe('owner');
});

it.each(['ausente', 'pausa', 'ocupado'])('routes a detected return through frozen coverage rules when owner is %s', async state => {
  const { distributeIndicacao } = await import('../queueEngine');
  const broker = (id: string, rank: number, equipe = 'A') => ({ id, operational_name:id, agency:'Viva Imóveis', equipe, presence_status:'presente', attendance_status:'livre', sorteio_order:rank, inverse_order:rank, shift:'manha', is_external_partner:false }) as Broker;
  const owner=broker('owner',1);
  if(state==='ocupado') owner.attendance_status='em_atendimento';
  else owner.presence_status=state as 'ausente'|'pausa';
  const rows=[owner,broker('team-first',2),broker('team-last',3),broker('company-last',4,'B')];
  const route=intakeRoute('11912345678',false,'Primeira visita',null,{visit:visit('old','11912345678'),ownerId:'owner'});
  expect(distributeIndicacao(rows,route.referred_broker_id,new Set()).broker?.id).toBe('team-last');
  rows[1].presence_status='pausa'; rows[2].presence_status='pausa';
  expect(distributeIndicacao(rows,route.referred_broker_id,new Set()).broker?.id).toBe('company-last');
});
