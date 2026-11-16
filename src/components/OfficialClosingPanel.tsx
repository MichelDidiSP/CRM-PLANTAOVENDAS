import { useState } from 'react';
import { dbReady, supabase } from '@/lib/supabase';
import { closePlantao, closingShareLinks, closingText, type ClosingSummary } from '@/lib/reports/officialClosing';

export default function OfficialClosingPanel({ date, closed, onClosed }: {
  date: string;
  closed: boolean;
  onClosed: () => void;
}) {
  const [summary, setSummary] = useState<ClosingSummary | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [requestLogin, setRequestLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function finalize(credentials?: { email: string; password: string }) {
    setBusy(true);
    setError('');
    try {
      if (await dbReady) {
        if (credentials) {
          const { error: signInError } = await supabase.auth.signInWithPassword(credentials);
          if (signInError) throw new Error('Não foi possível autenticar o operador.');
        } else {
          const { data } = await supabase.auth.getSession();
          if (!data.session) { setRequestLogin(true); return; }
        }
      }
      setSummary(await closePlantao(date));
      setRequestLogin(false);
      onClosed();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível fechar o plantão.');
    } finally {
      setPassword('');
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
    </> : <button type="button" disabled={busy || requestLogin} className="rounded bg-amber-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50"
      onClick={() => {
        if (closed || window.confirm('Fechar o plantão deste dia e salvar o relatório definitivo?')) void finalize();
      }}>{closed ? 'Consultar fechamento' : 'Fechar Plantão'}</button>}
    {requestLogin && <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={event => {
      event.preventDefault();
      void finalize({ email: email.trim(), password });
    }}>
      <label className="text-sm">E-mail do operador
        <input className="block rounded bg-slate-800 p-2" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} />
      </label>
      <label className="text-sm">Senha
        <input className="block rounded bg-slate-800 p-2" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
      </label>
      <button className="rounded bg-amber-400 px-3 py-2 text-slate-950" disabled={busy} type="submit">{closed ? 'Entrar e consultar' : 'Entrar e fechar plantão'}</button>
      <button type="button" disabled={busy} onClick={() => { setRequestLogin(false); setPassword(''); }}>Cancelar</button>
    </form>}
    {error && <p role="alert" className="mt-2 text-red-300">{error}</p>}
  </section>;
}
