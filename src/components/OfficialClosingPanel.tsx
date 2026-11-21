import { useState } from 'react';
import { closePlantao, closingShareLinks, closingText, type ClosingSummary } from '@/lib/reports/officialClosing';

export default function OfficialClosingPanel({ date, closed, onClosed, automaticSummary }: {
  date: string;
  closed: boolean;
  onClosed: () => void;
  automaticSummary?: ClosingSummary | null;
}) {
  const [manualSummary, setSummary] = useState<ClosingSummary | null>(null);
  const summary = automaticSummary?.date === date ? automaticSummary : manualSummary;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function finalize() {
    setBusy(true);
    setError('');
    try {
      setSummary(await closePlantao(date));
      onClosed();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível fechar o plantão.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="mb-4 rounded-xl border border-slate-700 bg-slate-900 p-4">
    {summary ? <>
      <h2 className="text-lg font-semibold">Relatório Quantitativo Final</h2>
      <div className="my-3 whitespace-pre-line">{closingText(summary)}</div>
      <div className="flex flex-wrap gap-4">
        {closingShareLinks(summary).map((link, index) => {
          const label = link.role === 'gerencia' ? 'Gerência' : 'Diretoria';
          return <div key={index} className="flex flex-wrap gap-2">
            {link.whatsapp && <a className="text-emerald-300 underline" href={link.whatsapp} target="_blank" rel="noreferrer">WhatsApp · {label}</a>}
            {link.email && <a className="text-sky-300 underline" href={link.email}>E-mail · {label}</a>}
          </div>;
        })}
      </div>
      {!summary.recipients.length && <p className="text-sm text-slate-400">Nenhum destinatário foi cadastrado.</p>}
    </> : <button type="button" disabled={busy} className="rounded bg-amber-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50"
      onClick={() => {
        if (closed || window.confirm('Fechar o plantão deste dia e salvar o relatório definitivo?')) void finalize();
      }}>{closed ? 'Consultar fechamento' : 'Fechar Plantão'}</button>}
    {error && <p role="alert" className="mt-2 text-red-300">{error}</p>}
  </section>;
}
