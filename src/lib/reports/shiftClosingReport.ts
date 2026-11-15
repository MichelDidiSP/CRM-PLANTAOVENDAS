/** Quantitative reporting only: no customer or broker identity enters this model. */
export const MEDIA_CHANNELS = [
  'Oferta Ativa (Lista Perfil)',
  'Pontos de Captação (Supermercados/Metrô/Feiras)',
  'Panfletagem (Incorporadora)',
  'Redes Sociais (Instagram/Facebook)',
  'Google / Pesquisa',
  'Portais Imobiliários',
  'Mídia Tradicional & Transporte (Rádio/TV/Ônibus)',
  'Placa / Passante',
  'Outros',
] as const;
/** Detail is stored only on the visit, never in quantitative report dimensions. */
export function mediaChannelFields(channel: string, detail = '') {
  if (!channel) return { media_channel: null, media_channel_detail: null };
  if (!(MEDIA_CHANNELS as readonly string[]).includes(channel)) throw new Error('Selecione um canal de mídia válido.');
  return { media_channel: channel, media_channel_detail: channel === 'Outros' ? detail.trim() || null : null };
}
export const ATTENDANCE_TYPES = ['Primeira Visita', 'Indicação', 'Retorno', 'Visita ao Decorado', 'Parceria Externa'] as const;
export const CHART_COLORS = ['#0055FF', '#008844', '#EEAA00', '#FF6600', '#6600CC'] as const;
export type AttendanceType = typeof ATTENDANCE_TYPES[number];
export const REPORT_PERIODS = { shift: 'Turno Atual', day: 'Hoje', week: 'Últimos 7 dias', fortnight: 'Últimos 15 dias', thirtyDays: 'Últimos 30 dias', month: 'Acumulado do Mês Atual', previousMonth: 'Mês Anterior', custom: 'Período Personalizado' } as const;
export type ReportPeriod = keyof typeof REPORT_PERIODS;
export type ReportScope = 'incorporadora' | 'imobiliaria';
export type ReportShift = 'manha' | 'tarde';
export type ReportFilter = { period: ReportPeriod; date: string; shift: ReportShift; startDate?: string; endDate?: string; scope?: ReportScope; company?: string };
export function scopeRows(rows: ReportRow[], filter: ReportFilter) {
  if (filter.scope !== 'imobiliaria') return rows;
  const company = filter.company?.trim();
  return company ? rows.filter(row => row.company.trim() === company) : [];
}
export type ReportRow = { date: string; shift: ReportShift; company: string; team: string; type: AttendanceType; media: string; count: number };
export type Breakdown = { label: string; count: number };
export type GroupRow = Breakdown & { company: string; team?: string; types: Record<AttendanceType, number> };
export function normalizedMedia(value?: string | null): string {
  const clean = value?.trim();
  if (!clean) return 'Outros';
  const key = clean.toLocaleLowerCase('pt-BR');
  const legacy: Record<string, typeof MEDIA_CHANNELS[number]> = {
    'oferta ativa': MEDIA_CHANNELS[0], 'lista incorporadora': MEDIA_CHANNELS[0],
    'instagram': MEDIA_CHANNELS[3], 'facebook': MEDIA_CHANNELS[3],
    'google': MEDIA_CHANNELS[4], 'portais': MEDIA_CHANNELS[5], 'placa/passante': MEDIA_CHANNELS[7],
  };
  return MEDIA_CHANNELS.find(label => label.toLocaleLowerCase('pt-BR') === key) ?? legacy[key] ?? 'Outros';
}
export function attendanceType(reason?: string | null, queueType?: string | null): AttendanceType {
  if (queueType === 'parceria' || reason === 'Parceria') return 'Parceria Externa';
  if (queueType === 'decorado' || reason === 'Decorado' || reason === 'Visita ao Decorado') return 'Visita ao Decorado';
  if (reason?.startsWith('Indicação')) return 'Indicação';
  if (reason === 'Retorno') return 'Retorno';
  return 'Primeira Visita';
}
export function businessDate(timestamp: string): string {
  const time = new Date(timestamp);
  if (!Number.isFinite(time.getTime())) throw new Error('Data de atendimento inválida.');
  return time.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}
function validDate(value: string | undefined): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Informe uma data válida.');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new Error('Informe uma data válida.');
  return date;
}
export function periodBounds(filter: ReportFilter) {
  const reference = validDate(filter.date);
  let start = new Date(reference), end = new Date(reference);
  switch (filter.period) {
    case 'shift': case 'day': break;
    case 'week': start.setUTCDate(start.getUTCDate()-6); break;
    case 'fortnight': start.setUTCDate(start.getUTCDate()-14); break;
    case 'thirtyDays': start.setUTCDate(start.getUTCDate()-29); break;
    case 'month': start.setUTCDate(1); break;
    case 'previousMonth': end.setUTCDate(0); start = new Date(end); start.setUTCDate(1); break;
    case 'custom': start=validDate(filter.startDate); end=validDate(filter.endDate); break;
    default: throw new Error('Período inválido.');
  }
  if (start > end) throw new Error('A data inicial deve ser anterior ou igual à data final.');
  return { start:start.toISOString().slice(0,10), end:end.toISOString().slice(0,10), days:Math.round((end.getTime()-start.getTime())/86400000)+1 };
}
export function isWeekend(date: string) {
  return [0,6].includes(validDate(date).getUTCDay());
}
const emptyTypes = () => Object.fromEntries(ATTENDANCE_TYPES.map(type => [type, 0])) as Record<AttendanceType, number>;
export function shiftClosingReport(rows: ReportRow[], filter: ReportFilter) {
  const bounds = periodBounds(filter);
  const selected = scopeRows(rows,filter).filter(row => row.date >= bounds.start && row.date <= bounds.end && (filter.period !== 'shift' || row.shift === filter.shift));
  const companies = new Map<string, GroupRow>();
  const teams = new Map<string, GroupRow>();
  const media = new Map<string, number>();
  const types = emptyTypes();
  const daily = new Map<string, number>();
  for (let i=0; i<bounds.days; i++) {
    const date = new Date(`${bounds.start}T12:00:00Z`); date.setUTCDate(date.getUTCDate()+i);
    daily.set(date.toISOString().slice(0,10),0);
  }
  let total = 0;
  for (const row of selected) {
    if (!Number.isSafeInteger(row.count) || row.count < 0 || !ATTENDANCE_TYPES.includes(row.type)) throw new Error('Contagem de relatório inválida.');
    if (!row.count) continue;
    total += row.count; types[row.type] += row.count;
    daily.set(row.date, (daily.get(row.date) ?? 0) + row.count);
    const company = row.company.trim() || 'Empresa não informada';
    const team = row.team.trim() || 'Sem Equipe';
    const channel = normalizedMedia(row.media === 'Não informado' ? null : row.media);
    media.set(channel, (media.get(channel) ?? 0) + row.count);
    for (const [map, key, label, teamName] of [[companies, company, company, undefined], [teams, JSON.stringify([company,team]), `${company} · ${team}`, team]] as const) {
      const group = map.get(key) ?? { label, company, team: teamName, count: 0, types: emptyTypes() };
      group.count += row.count; group.types[row.type] += row.count; map.set(key,group);
    }
  }
  const groups = (map: Map<string, GroupRow>) => [...map.values()].sort((a,b) => b.count-a.count || a.label.localeCompare(b.label, 'pt-BR'));
  return { filter: { ...filter }, ...bounds, total, referralsAndReturns: types['Indicação'] + types['Retorno'],
    companies: groups(companies), teams: groups(teams),
    types: ATTENDANCE_TYPES.map(label => ({ label, count: types[label] })),
    media: [...media].map(([label,count]) => ({ label,count })).sort((a,b) => b.count-a.count || a.label.localeCompare(b.label,'pt-BR')),
    daily: [...daily].map(([date,count]) => ({date,count})) };
}
export type ClosingReport = ReturnType<typeof shiftClosingReport>;
function csvCell(value: string | number) {
  const text = String(value);
  return '"' + (/^[=+@-]/.test(text) ? "'" + text : text).replace(/"/g,'""') + '"';
}
export function reportCsv(report: ClosingReport): string {
  const rows: (string | number)[][] = [
    ['Relatório quantitativo',report.start,report.end], ['Período',report.filter.period === 'shift' ? `Turno ${report.filter.shift}` : REPORT_PERIODS[report.filter.period]],
    ['Total de Atendimentos',report.total], ['Indicações/Retornos',report.referralsAndReturns], ['Visão',report.filter.scope === 'imobiliaria' ? `Imobiliária: ${report.filter.company?.trim() || 'Não selecionada'}` : 'Incorporadora — Global & Marketing'], [],
    ['Empresa','Equipe',...ATTENDANCE_TYPES,'Total'],
    ...report.companies.map(g => [g.company,'Todas',...ATTENDANCE_TYPES.map(t=>g.types[t]),g.count]),
    ...report.teams.map(g => [g.company,g.team ?? '',...ATTENDANCE_TYPES.map(t=>g.types[t]),g.count]), [],
    ['Tipo','Total'],...report.types.map(g=>[g.label,g.count]), [],
    ['Canal de Mídia','Total'],...report.media.map(g=>[g.label,g.count]), [],
    ['Dia','Total'],...report.daily.map(g=>[g.date,g.count]),
  ];
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n');
}
