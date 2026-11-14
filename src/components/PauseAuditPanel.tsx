import { useEffect, useState } from "react";
import { supabase, type Broker } from "@/lib/supabase";
type Audit = {
  id: string;
  broker_id: string;
  event: "evasion" | "excuse";
  scope: string;
  occurred_at: string;
  manager_name: string | null;
};
export default function PauseAuditPanel({ brokers }: { brokers: Broker[] }) {
  const [rows, setRows] = useState<Audit[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from("pause_audit")
        .select("*")
        .order("occurred_at", { ascending: false })
        .limit(100);
      if (!mounted) return;
      if (error) setError(error.message);
      else setRows((data ?? []) as Audit[]);
    }
    void load();
    const timer = window.setInterval(load, 3000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);
  return (
    <section className="bg-slate-900 border border-slate-700 rounded-2xl p-5 mb-6">
      <h2 className="font-bold text-lg mb-3">Log de evasão e abonos</h2>
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {!rows.length && (
        <p className="text-slate-400">Nenhum evento registrado.</p>
      )}
      <ul className="space-y-2 text-sm">
        {rows.map((row) => (
          <li key={row.id} className="border-b border-slate-800 py-2">
            {new Date(row.occurred_at).toLocaleString("pt-BR")} ·{" "}
            {brokers.find((b) => b.id === row.broker_id)?.operational_name ??
              row.broker_id}{" "}
            ·{" "}
            {row.event === "evasion"
              ? "Evasão após 120 minutos contínuos"
              : `Abono por ${row.manager_name}`}{" "}
            · {row.scope}
          </li>
        ))}
      </ul>
    </section>
  );
}
