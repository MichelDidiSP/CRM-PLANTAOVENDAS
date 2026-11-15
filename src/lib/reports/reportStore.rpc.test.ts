import { beforeEach, expect, it, vi } from 'vitest';
const { rpc, range } = vi.hoisted(()=>({rpc:vi.fn(),range:vi.fn()}));
vi.mock('../supabase',()=>({supabase:{rpc},dbReady:Promise.resolve(true)}));
import { loadReportRows } from './reportStore';
const fact=(company='Casa Nobre')=>({report_date:'2026-11-15',report_shift:'manha',company,team:'Equipe',attendance_type:'Primeira Visita',media_channel:'Oferta Ativa',total:1});
beforeEach(()=>{rpc.mockReset();range.mockReset();rpc.mockReturnValue({range});});
it('requests company filtering at the database and checks returned company again',async()=>{
 range.mockResolvedValue({data:[fact(),fact('Viva Imóveis')],error:null});
 const rows=await loadReportRows({date:'2026-11-15',shift:'manha',period:'fortnight',scope:'imobiliaria',company:'Casa Nobre'});
 expect(rpc).toHaveBeenCalledWith('quantitative_report_rows',{from_date:'2026-11-01',to_date:'2026-11-15',company_filter:'Casa Nobre'});
 expect(rows).toHaveLength(1);expect(rows[0].company).toBe('Casa Nobre');
});
it('does not query global data before a company is selected',async()=>{
 expect(await loadReportRows({date:'2026-11-15',shift:'manha',period:'day',scope:'imobiliaria'})).toEqual([]);
 expect(rpc).not.toHaveBeenCalled();
});
it('paginates longer reporting periods without truncating at one thousand groups',async()=>{
 range.mockResolvedValueOnce({data:Array.from({length:1000},()=>fact()),error:null}).mockResolvedValueOnce({data:[fact()],error:null});
 const rows=await loadReportRows({date:'2026-11-15',shift:'manha',period:'previousMonth',scope:'incorporadora'});
 expect(rows).toHaveLength(1001);expect(range).toHaveBeenNthCalledWith(1,0,999);expect(range).toHaveBeenNthCalledWith(2,1000,1999);
 expect(rpc).toHaveBeenCalledWith('quantitative_report_rows',{from_date:'2026-10-01',to_date:'2026-10-31',company_filter:null});
});
it('propagates a database error instead of showing partial totals',async()=>{
 range.mockResolvedValue({data:null,error:new Error('Unavailable')});
 await expect(loadReportRows({date:'2026-11-15',shift:'manha',period:'day'})).rejects.toThrow('Unavailable');
});
