import { useEffect, useMemo, useRef, useState } from 'react';
import { useSim } from '@/lib/simContext';
import { loadReportRows } from '@/lib/reports/reportStore';
import { REPORT_PERIODS, periodBounds, isWeekend, ATTENDANCE_TYPES, CHART_COLORS, reportCsv, shiftClosingReport, type Breakdown, type GroupRow, type ReportScope, type ReportPeriod, type ReportRow } from '@/lib/reports/shiftClosingReport';

const number = (n: number, digits = 0) => n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const dateLabel = (date: string) => date.split('-').reverse().join('/');
const button = 'rounded-lg border border-slate-400 px-3 py-2 text-sm font-semibold hover:bg-slate-100 disabled:opacity-40';
export default function ShiftClosingDashboard() {
  const { plantaoDate, currentShift, isExtendedShift } = useSim();
  const [period, setPeriod] = useState<ReportPeriod>('shift');
  const [scope, setScope] = useState<ReportScope>('incorporadora');
  const [company, setCompany] = useState('');
  const [draftStart, setDraftStart] = useState(plantaoDate);
  const [draftEnd, setDraftEnd] = useState(plantaoDate);
  const [range, setRange] = useState({ startDate: plantaoDate, endDate: plantaoDate });
  const [rangeError, setRangeError] = useState('');
  const [loadedKey, setLoadedKey] = useState('');
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [updated, setUpdated] = useState('');
  const printable = useRef<HTMLDivElement>(null);
  const filter = useMemo(() => ({ period, date: plantaoDate, shift: currentShift, scope, company, ...range }),[period,plantaoDate,currentShift,scope,company,range]);
  const filterKey = JSON.stringify(filter);
  const ready = !loading && loadedKey === filterKey && !error;
  const report = useMemo(() => shiftClosingReport(rows,filter),[rows,filter]);
  useEffect(() => {
    let active = true;
    let running = false;
    setRows([]); setLoading(true); setError('');
    async function refresh() {
      if(running) return;
      running=true;
      try {
        const next = await loadReportRows(filter);
        if(active) { setRows(next); setLoadedKey(JSON.stringify(filter)); setError(''); setUpdated(new Date().toLocaleTimeString('pt-BR')); }
      } catch { if(active) setError('Não foi possível carregar o relatório. Verifique a conexão e a aplicação da migração de relatórios.'); }
      finally { running=false; if(active) setLoading(false); }
    }
    void refresh();
    const timer = window.setInterval(refresh,5000);
    return () => { active=false; window.clearInterval(timer); };
  },[filter,retry]);
  const title = period === 'shift' ? `Turno Atual — ${isExtendedShift ? 'Integral' : currentShift === 'manha' ? 'Manhã' : 'Tarde'}` : REPORT_PERIODS[period];
  function applyRange() {
    try {
      periodBounds({ ...filter, period:'custom', startDate:draftStart, endDate:draftEnd });
      setRange({startDate:draftStart,endDate:draftEnd}); setRangeError('');
    } catch (error) { setRangeError(error instanceof Error ? error.message : 'Datas inválidas.'); }
  }
  function download() {
    const url=URL.createObjectURL(new Blob([reportCsv(report)],{type:'text/csv;charset=utf-8;'}));
    const anchor=document.createElement('a'); anchor.href=url; anchor.download=`relatorio-quantitativo-${period}-${plantaoDate}.csv`; anchor.click();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function printReport() {
    if(!printable.current) return;
    const content = printable.current.cloneNode(true) as HTMLDivElement;
    content.querySelectorAll('figure').forEach(figure => figure.remove());
    content.querySelectorAll('details').forEach(details => details.setAttribute('open',''));
    const frame=document.createElement('iframe');
    frame.title='Impressão do relatório quantitativo';
    frame.style.cssText='position:fixed;width:0;height:0;border:0;';
    frame.onload=()=>{ frame.contentWindow?.addEventListener('afterprint',()=>frame.remove(),{once:true}); frame.contentWindow?.focus(); frame.contentWindow?.print(); };
    frame.srcdoc=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório quantitativo</title><style>body{font:12px Arial;color:#111;background:white}h2,h3{break-after:avoid}table{border-collapse:collapse;width:100%;margin:12px 0;break-inside:auto}tr{break-inside:avoid}th,td{border:1px solid #aaa;padding:6px;text-align:left}svg{width:180px;height:180px}figure{break-inside:avoid;margin:16px 0}button{display:none}li{margin:5px}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}@page{size:A4;margin:14mm}</style></head><body>${content.innerHTML}</body></html>`;
    document.body.appendChild(frame);
  }
  return <section aria-label="Relatório quantitativo" className="mb-8 rounded-2xl bg-white text-slate-950 p-5 sm:p-7 border border-slate-300">
    <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
      <div><p className="text-xs font-bold uppercase tracking-widest text-slate-600">Desempenho do plantão</p><h2 className="text-2xl font-bold">Relatório quantitativo</h2></div>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={!ready || (scope === 'imobiliaria' && !company)} title="Imprimir indicadores e tabelas em formato limpo" onClick={printReport}>Imprimir / Salvar PDF</button><button className={button} disabled={!ready || (scope === 'imobiliaria' && !company)} onClick={download}>Exportar CSV</button></div>
    </div>
    <div className="grid md:grid-cols-2 gap-4 mb-4">
      <label className="text-sm font-semibold">Nível de visualização
        <select aria-label="Nível de visualização" className="block border border-slate-400 rounded-lg p-2 mt-1 w-full bg-white" value={scope} onChange={e=>setScope(e.target.value as ReportScope)}>
          <option value="incorporadora">Incorporadora — Visão Global &amp; Marketing</option>
          <option value="imobiliaria">Imobiliária — Própria Empresa</option>
        </select>
      </label>
      {scope === 'imobiliaria' && <label className="text-sm font-semibold">Minha imobiliária
        <select aria-label="Minha imobiliária" className="block border border-slate-400 rounded-lg p-2 mt-1 w-full bg-white" value={company} onChange={e=>setCompany(e.target.value)}>
          <option value="">Selecione a empresa</option><option>Viva Imóveis</option><option>Casa Nobre</option>
        </select>
      </label>}
    </div>
    <p className="text-xs text-slate-600 mb-4">Prévia de visualização por empresa. A vinculação automática ao usuário dependerá do login futuro.</p>
    <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Período do relatório">{(Object.entries(REPORT_PERIODS) as [ReportPeriod,string][]).map(([value,label])=><button key={value} aria-pressed={period===value} onClick={()=>{setPeriod(value);setRangeError('');}} className={button} style={period===value?{background:'#0055FF',color:'#fff',borderColor:'#0055FF'}:undefined}>{label}</button>)}</div>
    {period === 'custom' && <div className="mb-4">
      <div className="flex flex-wrap items-end gap-3"><label className="text-sm">Data Inicial<input aria-label="Data Inicial" type="date" className="block border border-slate-400 p-2 rounded-lg" value={draftStart} onChange={e=>setDraftStart(e.target.value)}/></label><label className="text-sm">Data Final<input aria-label="Data Final" type="date" className="block border border-slate-400 p-2 rounded-lg" value={draftEnd} onChange={e=>setDraftEnd(e.target.value)}/></label><button className={button} onClick={applyRange}>Aplicar período</button></div>
      {rangeError && <p role="alert" className="mt-2 text-sm">{rangeError}</p>}
    </div>}
    <p className="text-xs text-slate-600 mb-4">Data de referência: {dateLabel(plantaoDate)} · Atualização a cada 5 segundos{updated ? ` · Última leitura: ${updated}` : ''}</p>
    {scope === 'imobiliaria' && !company ? <p role="status">Selecione sua imobiliária para visualizar seus volumes.</p> : (loading || (!error && loadedKey !== filterKey)) ? <p role="status">Carregando totais…</p> : error ? <div role="alert"><p>{error}</p><button className={button+' mt-2'} onClick={()=>setRetry(n=>n+1)}>Tentar novamente</button></div> : <div ref={printable}>
      <h3 className="text-lg font-bold">{title}</h3><p className="font-semibold">{scope === 'imobiliaria' ? `Imobiliária: ${company}` : 'Incorporadora — Visão Global & Marketing'}</p><p className="text-sm text-slate-600 mb-5">{dateLabel(report.start)} a {dateLabel(report.end)}</p>
      <div className="grid sm:grid-cols-2 gap-4 mb-6">{[['Total de Atendimentos',number(report.total)],['Total de Indicações/Retornos',number(report.referralsAndReturns)]].map(([label,value])=><div key={label} className="border border-slate-300 rounded-xl p-4"><p className="text-sm font-semibold text-slate-600">{label}</p><p className="text-4xl font-bold mt-2">{value}</p></div>)}</div>
      <p className="text-sm text-slate-600 mb-5">Atendimentos iniciados ou concluídos, contados uma vez por registro. Parcerias contam após confirmação do gerente. O dia segue a data de chegada em São Paulo, e o turno segue o histórico da fila. A evolução diária inclui os dias sem movimento com volume zero. Empresa e equipe correspondem ao atendente efetivo.</p>
      {!report.total && <p role="status" className="p-4 border border-slate-300 rounded-lg mb-4">Nenhum atendimento realizado neste período.</p>}
      <div className="grid xl:grid-cols-2 gap-6 mb-6"><Donut title="Atendimentos por Imobiliária" rows={report.companies}/><Donut title="Origem por Canal de Mídia" rows={report.media}/></div>
      <DailyColumns rows={report.daily}/>
      <TeamColumns rows={report.teams}/>
      <h3 className="font-bold text-xl mt-8 mb-3">Relatório quantitativo escrito</h3>
      <GroupTable title="Totais por Empresa" rows={report.companies}/>
      <GroupTable title="Totais por Equipe e Empresa" rows={report.teams}/>
      <div className="grid lg:grid-cols-2 gap-6"><CountTable title="Totais por Tipo de Atendimento" rows={report.types}/><CountTable title="Totais por Canal de Mídia" rows={report.media}/></div>
      <details className="mt-4"><summary className="cursor-pointer font-semibold">Tabela de evolução diária</summary><table className="w-full text-sm"><thead><tr><th className="text-left p-2">Dia</th><th className="text-right p-2">Atendimentos</th></tr></thead><tbody>{report.daily.map(day=><tr key={day.date}><td className="p-2">{dateLabel(day.date)}</td><td className="p-2 text-right">{day.count}</td></tr>)}</tbody></table></details>
      <p className="text-xs text-slate-600 mt-4">Histórico anterior usa os dados disponíveis na importação. Canais não informados ou legados sem correspondência são agrupados em “Outros”. A parceria externa tem contabilização separada das equipes internas. Nenhum dado pessoal de cliente integra este relatório ou sua exportação.</p>
    </div>}
  </section>;
}
function Donut({title,rows}:{title:string;rows:Breakdown[]}) {
  const total=rows.reduce((sum,row)=>sum+row.count,0);
  const radius=64, circumference=2*Math.PI*radius;
  let offset=0;
  return <figure className="border border-slate-300 rounded-xl p-4"><figcaption className="font-bold mb-3">{title}</figcaption>
    {total ? <div className="flex flex-wrap items-center gap-4"><svg role="img" aria-label={`${title}: ${rows.map(r=>`${r.label}, ${r.count} atendimentos`).join('; ')}`} viewBox="0 0 200 200" className="w-48 h-48 shrink-0">
      {rows.map((row,index)=>{const share=row.count/total; const start=offset; offset+=share; const angle=(start+share/2)*2*Math.PI-Math.PI/2; return <g key={row.label}><circle cx="100" cy="100" r={radius} fill="none" stroke={CHART_COLORS[index%5]} strokeWidth="34" strokeDasharray={`${share*circumference} ${circumference}`} strokeDashoffset={-start*circumference} transform="rotate(-90 100 100)"/><text x={100+radius*Math.cos(angle)} y={104+radius*Math.sin(angle)} textAnchor="middle" fontSize="11" fontWeight="bold" fill={[2,3].includes(index%5)?'#000':'#fff'}>{share>=0.04?index+1:''}</text></g>})}
      <text x="100" y="99" textAnchor="middle" fontSize="25" fontWeight="bold">{total}</text><text x="100" y="118" textAnchor="middle" fontSize="11">atendimentos</text>
    </svg><ol className="space-y-2 text-sm flex-1 min-w-[160px]">{rows.map((row,index)=><li key={row.label} className="flex gap-2 items-start"><span aria-hidden="true" className="w-3 h-3 mt-1 shrink-0" style={{background:CHART_COLORS[index%5]}}/><span>{index+1}. {row.label} — <strong>{row.count}</strong></span></li>)}</ol></div>:<p className="text-sm text-slate-600">Sem dados no período.</p>}
  </figure>;
}
function TeamColumns({rows}:{rows:GroupRow[]}) {
  const types=ATTENDANCE_TYPES.slice(0,4);
  const internal=rows.filter(r=>types.some(t=>r.types[t]>0));
  const max=Math.max(1,...internal.map(r=>types.reduce((sum,t)=>sum+r.types[t],0)));
  return <figure className="border border-slate-300 rounded-xl p-4"><figcaption className="font-bold mb-3">Comparativo de Equipes por Tipo de Atendimento</figcaption>
    <ul className="flex flex-wrap gap-4 text-xs mb-5">{types.map((type,i)=><li key={type}><span className="inline-block w-3 h-3 mr-1" style={{background:CHART_COLORS[i]}}/>{type}</li>)}</ul>
    {!internal.length ? <p className="text-sm text-slate-600">Sem atendimentos de equipes internas no período.</p>:<div className="overflow-x-auto"><div className="flex items-end gap-6 pb-2" style={{minWidth:Math.max(300,internal.length*120)}}>{internal.map(row=>{
      const total=types.reduce((sum,t)=>sum+row.types[t],0);
      return <div key={row.label} className="flex-1 min-w-[96px] max-w-[160px] text-center"><div className="h-52 flex flex-col justify-end"><strong className="text-sm mb-1">{total}</strong><div role="img" aria-label={`${row.label}: ${types.map(t=>`${t} ${row.types[t]}`).join(', ')}`} className="flex flex-col-reverse mx-auto w-16" style={{height:`${total/max*170}px`}}>{types.map((type,i)=><div key={type} style={{height:`${row.types[type]/total*100}%`,background:CHART_COLORS[i],color:i>=2?'#000':'#fff'}} className="flex items-center justify-center text-xs font-bold overflow-hidden">{row.types[type] ? row.types[type] : ''}</div>)}</div></div><p className="text-xs font-semibold mt-3 break-words">{row.team}</p><p className="text-xs text-slate-600">{row.company}</p></div>;
    })}</div></div>}
  </figure>;
}
function GroupTable({title,rows}:{title:string;rows:GroupRow[]}) {
  return <div className="overflow-x-auto mb-6"><table className="w-full text-sm border-collapse"><caption className="text-left font-bold mb-2">{title}</caption><thead><tr className="border-b-2 border-slate-400"><th className="p-2 text-left">Empresa / Equipe</th>{ATTENDANCE_TYPES.map(t=><th key={t} className="p-2 text-right">{t}</th>)}<th className="p-2 text-right">Total</th></tr></thead><tbody>{rows.map(row=><tr key={row.label} className="border-b border-slate-200"><th scope="row" className="p-2 text-left font-normal">{row.label}</th>{ATTENDANCE_TYPES.map(t=><td key={t} className="p-2 text-right tabular-nums">{row.types[t]}</td>)}<td className="p-2 text-right font-bold">{row.count}</td></tr>)}</tbody><tfoot><tr className="border-t-2 border-slate-400 font-bold"><th className="p-2 text-left">Total</th>{ATTENDANCE_TYPES.map(t=><td key={t} className="p-2 text-right">{rows.reduce((s,r)=>s+r.types[t],0)}</td>)}<td className="p-2 text-right">{rows.reduce((s,r)=>s+r.count,0)}</td></tr></tfoot></table></div>;
}
function CountTable({title,rows}:{title:string;rows:Breakdown[]}) {
  return <table className="w-full text-sm mb-4"><caption className="text-left font-bold mb-2">{title}</caption><thead><tr className="border-b-2 border-slate-400"><th className="p-2 text-left">Categoria</th><th className="p-2 text-right">Total</th></tr></thead><tbody>{rows.map(row=><tr key={row.label} className="border-b border-slate-200"><th scope="row" className="p-2 text-left font-normal">{row.label}</th><td className="p-2 text-right">{row.count}</td></tr>)}</tbody></table>;
}

function DailyColumns({rows}:{rows:{date:string;count:number}[]}) {
  const peak=rows.reduce((max,row)=>Math.max(max,row.count),0);
  return <figure className="border border-slate-300 rounded-xl p-4 mb-6">
    <figcaption className="font-bold mb-2">Evolução Dia a Dia — Volume de Atendimentos</figcaption>
    <p className="text-sm text-slate-600 mb-4">Pico no período: {peak} atendimentos em um dia. Sábados e domingos estão destacados em ouro. Os demais dias usam azul.</p>
    <div className="overflow-x-auto" tabIndex={0} aria-label="Evolução diária, role horizontalmente para consultar todas as datas">
      <div className="flex items-end gap-3 border-b border-slate-400 pb-3" style={{minWidth:Math.max(300,rows.length*64)}}>
        {rows.map(row=><div key={row.date} className="flex-1 min-w-[52px] text-center">
          <div className="h-48 flex flex-col justify-end"><strong className="text-sm mb-1">{row.count}</strong><div role="img" aria-label={`${dateLabel(row.date)}: ${row.count} atendimentos${isWeekend(row.date)?', fim de semana':''}`} className="mx-auto w-8" style={{height:peak?row.count/peak*150:0,background:isWeekend(row.date)?'#EEAA00':'#0055FF'}}/></div>
          <p className="text-xs mt-2 font-semibold">{dateLabel(row.date).slice(0,5)}</p><p className="text-xs text-slate-600">{new Date(row.date+'T12:00:00Z').toLocaleDateString('pt-BR',{weekday:'short',timeZone:'UTC'})}</p>
        </div>)}
      </div>
    </div>
  </figure>;
}
