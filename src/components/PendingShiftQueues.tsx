import type { Broker } from "@/lib/supabase";
import type { ShiftDraw } from "@/lib/queue/shiftSchedule";
export default function PendingShiftQueues({
  draw,
  brokers,
}: {
  draw: ShiftDraw;
  brokers: Broker[];
}) {
  return (
    <section className="mb-6">
      <h2 className="text-lg text-indigo-300 mb-3">
        Tarde — ativação às 14:00:01
      </h2>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {[
          { label: "Viva Imóveis", ids: draw.viva },
          { label: "Casa Nobre", ids: draw.nobre },
          { label: "Inversa geral", ids: draw.inverse },
        ].map((column) => (
          <div
            key={column.label}
            className="bg-slate-900 border border-indigo-500/30 rounded-2xl p-6"
          >
            <h3 className="text-indigo-300 font-bold mb-3">{column.label}</h3>
            <ol className="list-decimal pl-5 space-y-2 text-slate-200">
              {column.ids.map((id) => (
                <li key={id}>
                  {brokers.find((b) => b.id === id)?.operational_name ?? id}
                </li>
              ))}
            </ol>
            {!column.ids.length && (
              <p className="text-slate-400">Sem inscritos.</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
