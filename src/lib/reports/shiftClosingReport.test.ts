import { describe, it, expect } from 'vitest';
import { MEDIA_CHANNELS, mediaChannelFields, ATTENDANCE_TYPES, CHART_COLORS, shiftClosingReport, periodBounds, isWeekend, businessDate, normalizedMedia, attendanceType, reportCsv, type ReportRow } from './shiftClosingReport';
const row=(patch: Partial<ReportRow>={}):ReportRow=>({date:'2026-11-15',shift:'manha',company:'Viva Imóveis',team:'Equipe A',type:'Primeira Visita',media:'Instagram',count:1,...patch});
const rows=[row({count:4}),row({shift:'tarde',count:3,type:'Indicação',media:'Google'}),row({company:'Casa Nobre',type:'Retorno',media:'Portais',count:2}),row({date:'2026-11-09',type:'Visita ao Decorado',media:'',count:5}),row({date:'2026-11-08',count:100}),row({date:'2026-11-16',count:100}),row({company:'Parceria Externa',team:'Parcerias',type:'Parceria Externa',media:'',count:1})];
const filter={date:'2026-11-15',shift:'manha' as const};
describe('Quantitative closing report',()=>{
  it('counts only current morning and includes external partnerships',()=>{ const report=shiftClosingReport(rows,{...filter,period:'shift'}); expect(report.total).toBe(7); expect(report.referralsAndReturns).toBe(2); expect(report).not.toHaveProperty('dailyAverage'); });
  it('separates the afternoon from the morning',()=>{const r=shiftClosingReport(rows,{...filter,shift:'tarde',period:'shift'});expect(r.total).toBe(3);expect(r.referralsAndReturns).toBe(3);});
  it('consolidates both shifts for the day',()=>{const r=shiftClosingReport(rows,{...filter,period:'day'});expect(r.total).toBe(10);expect(r).not.toHaveProperty('dailyAverage');expect(r.referralsAndReturns).toBe(5);});
  it('includes exactly the selected date and previous six dates',()=>{const r=shiftClosingReport(rows,{...filter,period:'week'});expect(r.start).toBe('2026-11-09');expect(r.total).toBe(15);expect(r.daily.reduce((n,d)=>n+d.count,0)).toBe(15);expect(r.daily).toHaveLength(7);expect(r.daily.filter(d=>d.count===0)).toHaveLength(5);});
  it('groups by company with absolute totals',()=>{const r=shiftClosingReport(rows,{...filter,period:'day'});expect(r.companies.map(c=>[c.label,c.count])).toEqual([['Viva Imóveis',7],['Casa Nobre',2],['Parceria Externa',1]]);});
  it('does not merge equal team names in different companies',()=>{const r=shiftClosingReport(rows,{...filter,period:'day'});expect(r.teams.filter(t=>t.team==='Equipe A')).toHaveLength(2);expect(r.teams.find(t=>t.company==='Viva Imóveis')?.types['Indicação']).toBe(3);});
  it('crosses company and team totals with every attendance type',()=>{const r=shiftClosingReport(rows,{...filter,period:'week'});for(const group of [...r.companies,...r.teams])expect(Object.values(group.types).reduce((a,b)=>a+b,0)).toBe(group.count);expect(r.types.map(t=>[t.label,t.count])).toEqual([['Primeira Visita',4],['Indicação',3],['Retorno',2],['Visita ao Decorado',5],['Parceria Externa',1]]);});
  it('keeps unknown media in its explicit bucket',()=>{const r=shiftClosingReport(rows,{...filter,period:'week'});expect(r.media.find(m=>m.label==='Outros')?.count).toBe(6);expect(r.media.reduce((a,b)=>a+b.count,0)).toBe(r.total);});
  it('supports a single full-day shift including evening overtime',()=>{const r=shiftClosingReport([row({shift:'manha',count:8})],{...filter,period:'shift'});expect(r.total).toBe(8);});
  it('handles empty periods with absolute zeros',()=>{const r=shiftClosingReport([],{...filter,period:'week'});expect(r.total).toBe(0);expect(r).not.toHaveProperty('dailyAverage');expect(r.types.every(t=>t.count===0)).toBe(true);expect(r.companies).toEqual([]);});
  it.each(['2026-11-00','2026-02-30','not-a-date'])('rejects invalid reference date %s',date=>expect(()=>periodBounds({...filter,date,period:'week'})).toThrow());
  it('spans month and year boundaries',()=>expect(periodBounds({...filter,date:'2027-01-03',period:'week'})).toEqual({start:'2026-12-28',end:'2027-01-03',days:7}));
  it('uses São Paulo date at midnight UTC boundaries',()=>{expect(businessDate('2026-11-15T02:59:59Z')).toBe('2026-11-14');expect(businessDate('2026-11-15T03:00:00Z')).toBe('2026-11-15');});
  it.each([-1,0.5,NaN,Infinity])('rejects invalid count %s',count=>expect(()=>shiftClosingReport([row({count})],{...filter,period:'day'})).toThrow());
  it('canonicalizes channels and never exposes arbitrary personal text in channel labels',()=>{expect(normalizedMedia(' google ')).toBe('Google / Pesquisa');expect(normalizedMedia('Maria Silva 11999999999')).toBe('Outros');expect(normalizedMedia(null)).toBe('Outros');});
  it.each(['Indicação','Indicação Presente','Indicação Ausente','Indicação Imobiliária'])('groups subtype %s as Indicação',type=>expect(attendanceType(type)).toBe('Indicação'));
  it('prioritizes actual Decorado and partnership queue types',()=>{expect(attendanceType('Primeira visita','decorado')).toBe('Visita ao Decorado');expect(attendanceType('Parceria','geral')).toBe('Parceria Externa');expect(attendanceType('Retorno')).toBe('Retorno');});
  it('contains only the requested pure chart colors',()=>expect([...CHART_COLORS]).toEqual(['#0055FF','#008844','#EEAA00','#FF6600','#6600CC']));
  it('exports all quantitative dimensions with no raw personal or technical IDs',()=>{
    const raw={...row(),customer_name:'Maria Silva',phone:'11999999999',broker_id:'private-broker-id'};
    const report=shiftClosingReport([raw],{...filter,period:'day'});
    const serialized=JSON.stringify(report)+reportCsv(report);
    for(const privateValue of ['Maria Silva','11999999999','private-broker-id','customer_name','phone'])expect(serialized).not.toContain(privateValue);
    expect(reportCsv(report)).toContain('Canal de Mídia'); expect(reportCsv(report)).toContain('Empresa');expect(reportCsv(report)).toContain('Equipe');
    expect(reportCsv(report)).not.toContain('Média');expect(reportCsv(report)).not.toContain('%');
  });
  it('escapes spreadsheet formulas and quotes in labels',()=>{const csv=reportCsv(shiftClosingReport([row({company:'=1+1',team:'Equipe "A"'})],{...filter,period:'day'}));expect(csv).toContain('"\'=1+1"');expect(csv).toContain('Equipe ""A""');});
  it('does not mutate rows or merge per-visit entries sharing a telephone',()=>{const input=Object.freeze([Object.freeze(row()),Object.freeze(row())]);expect(shiftClosingReport([...input],{...filter,period:'day'}).total).toBe(2);});
});


describe('Expanded absolute reporting',()=>{
  it.each([
    ['fortnight','2026-11-01','2026-11-15',15],
    ['thirtyDays','2026-10-17','2026-11-15',30],
    ['month','2026-11-01','2026-11-15',15],
    ['previousMonth','2026-10-01','2026-10-31',31],
  ] as const)('calculates inclusive bounds for %s',(period,start,end,days)=>expect(periodBounds({...filter,period})).toEqual({start,end,days}));
  it.each([
    ['2024-03-05','2024-02-01','2024-02-29',29],
    ['2025-03-05','2025-02-01','2025-02-28',28],
    ['2026-01-01','2025-12-01','2025-12-31',31],
  ])('handles previous month at %s',(date,start,end,days)=>expect(periodBounds({...filter,date:String(date),period:'previousMonth'})).toEqual({start,end,days}));
  it('starts current month with exactly one day on its first day',()=>expect(periodBounds({...filter,date:'2026-12-01',period:'month'})).toEqual({start:'2026-12-01',end:'2026-12-01',days:1}));
  it('includes both custom boundary dates and zero days in the daily series',()=>{
    const result=shiftClosingReport([row({date:'2026-11-01',count:3}),row({date:'2026-11-03',count:9}),row({date:'2026-11-04',count:100})],{...filter,period:'custom',startDate:'2026-11-01',endDate:'2026-11-03'});
    expect(result.total).toBe(12);expect(result.daily).toEqual([{date:'2026-11-01',count:3},{date:'2026-11-02',count:0},{date:'2026-11-03',count:9}]);
  });
  it('accepts a single-day custom interval',()=>expect(periodBounds({...filter,period:'custom',startDate:'2026-11-15',endDate:'2026-11-15'}).days).toBe(1));
  it.each([
    ['','2026-11-15'],['2026-11-01',''],['2026-11-20','2026-11-15'],['2026-02-30','2026-11-15'],['2026-11-01','bad'],
  ])('rejects invalid custom dates %s to %s',(startDate,endDate)=>expect(()=>periodBounds({...filter,period:'custom',startDate,endDate})).toThrow());
  it('filters every dimension and export to the selected company',()=>{
    const result=shiftClosingReport(rows,{...filter,period:'week',scope:'imobiliaria',company:'Casa Nobre'});
    expect(result.total).toBe(2);expect(result.referralsAndReturns).toBe(2);
    expect(result.companies.map(c=>c.label)).toEqual(['Casa Nobre']);expect(result.teams.map(t=>t.company)).toEqual(['Casa Nobre']);
    expect(result.media.map(m=>m.label)).toEqual(['Portais Imobiliários']);expect(result.daily.reduce((s,d)=>s+d.count,0)).toBe(2);
    const csv=reportCsv(result);expect(csv).not.toContain('Viva Imóveis');expect(csv).not.toContain('Instagram');expect(csv).not.toContain('Google');expect(csv).toContain('Imobiliária: Casa Nobre');
  });
  it.each(['', '  ', 'Unknown Company'])('never falls back to global for missing/rejected company %s',company=>{
    const result=shiftClosingReport(rows,{...filter,period:'day',scope:'imobiliaria',company});
    expect(result.total).toBe(0);expect(result.teams).toEqual([]);expect(result.media).toEqual([]);
  });
  it('global scope keeps all companies even after switching from a selected company',()=>expect(shiftClosingReport(rows,{...filter,period:'day',scope:'incorporadora',company:'Casa Nobre'}).total).toBe(10));
  it('exports only absolute values with no averages or percentages',()=>{
    const result=shiftClosingReport(rows,{...filter,period:'fortnight'});const output=JSON.stringify(result)+reportCsv(result);
    expect(output).not.toMatch(/dailyAverage|percentage|Média|%/);expect(reportCsv(result)).toContain('Últimos 15 dias');
  });
  it('recognizes Saturday and Sunday independently of host timezone',()=>{expect(isWeekend('2026-11-14')).toBe(true);expect(isWeekend('2026-11-15')).toBe(true);expect(isWeekend('2026-11-16')).toBe(false);});
  it.each(['Oferta Ativa','Lista Incorporadora'])('keeps the internal channel %s separate',media=>{
    expect(normalizedMedia(' '+media.toLowerCase()+' ')).toBe('Oferta Ativa (Lista Perfil)');
    expect(shiftClosingReport([row({media})],{...filter,period:'day'}).media).toEqual([{label:'Oferta Ativa (Lista Perfil)',count:1}]);
  });
});


describe('Nine media channels and optional detail',()=>{
  it('offers exactly the nine approved labels in order',()=>expect([...MEDIA_CHANNELS]).toEqual([
    'Oferta Ativa (Lista Perfil)', 'Pontos de Captação (Supermercados/Metrô/Feiras)',
    'Panfletagem (Incorporadora)', 'Redes Sociais (Instagram/Facebook)', 'Google / Pesquisa',
    'Portais Imobiliários', 'Mídia Tradicional & Transporte (Rádio/TV/Ônibus)', 'Placa / Passante', 'Outros',
  ]));
  it.each([...MEDIA_CHANNELS])('stores and groups the exact channel %s',channel=>{
    expect(mediaChannelFields(channel)).toEqual({media_channel:channel,media_channel_detail:null});
    expect(normalizedMedia(channel.toLowerCase())).toBe(channel);
    expect(shiftClosingReport([row({media:channel})],{...filter,period:'day'}).media).toEqual([{label:channel,count:1}]);
  });
  it.each([
    ['Instagram','Redes Sociais (Instagram/Facebook)'],['Facebook','Redes Sociais (Instagram/Facebook)'],
    ['Google','Google / Pesquisa'],['Portais','Portais Imobiliários'],['Placa/Passante','Placa / Passante'],
    ['Oferta Ativa','Oferta Ativa (Lista Perfil)'],['Lista Incorporadora','Oferta Ativa (Lista Perfil)'],['Indicação','Outros'],
  ])('maps historical %s into %s without additional report categories',(old,canonical)=>expect(normalizedMedia(old)).toBe(canonical));
  it('stores the trimmed free-text action only for Outros',()=>expect(mediaChannelFields('Outros','  Ação no evento local  ')).toEqual({media_channel:'Outros',media_channel_detail:'Ação no evento local'}));
  it.each(['','   '])('allows Outros without optional detail %s',detail=>expect(mediaChannelFields('Outros',detail).media_channel_detail).toBeNull());
  it.each(MEDIA_CHANNELS.filter(c=>c!=='Outros'))('discards stale detail for %s',channel=>expect(mediaChannelFields(channel,'Detalhe antigo').media_channel_detail).toBeNull());
  it('clears both fields when no channel is supplied',()=>expect(mediaChannelFields('','Detalhe antigo')).toEqual({media_channel:null,media_channel_detail:null}));
  it('rejects a channel outside the dropdown when creating a visit',()=>expect(()=>mediaChannelFields('Instagram')).toThrow());
  it('keeps free text out of all quantitative reports and exports',()=>{
    const detailed = {...row({media:'Outros'}),media_channel_detail:'PRIVATE FREE TEXT'};
    const report=shiftClosingReport([detailed],{...filter,period:'day'});
    expect(report.media).toEqual([{label:'Outros',count:1}]);
    expect(JSON.stringify(report)+reportCsv(report)).not.toContain('PRIVATE FREE TEXT');
  });
});
