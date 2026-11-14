import { useState } from "react";
import { actOnPause } from "@/lib/queue/pauseAndPartnersStore";
import {
  onlyOwn,
  pauseElapsed,
  type PauseBroker,
  type PauseClock,
} from "@/lib/queue/pauseAndPartners";
export default function BrokerPauseDetails({
  broker,
  clock,
}: {
  broker: PauseBroker;
  clock: PauseClock;
}) {
  const [manager, setManager] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function excuse() {
    setSaving(true);
    setError("");
    try {
      await actOnPause(broker.id, "excuse", clock, manager);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mt-3 space-y-2 text-sm">
      {broker.pause_started_at && (
        <p className="text-amber-300">
          Pausa contínua · {Math.floor(pauseElapsed(broker, clock.at) / 60000)}{" "}
          min · posição de saída {broker.pause_exit_index ?? "—"}
        </p>
      )}
      {onlyOwn(broker) && (
        <p className="text-purple-300">
          Somente indicação própria e retorno próprio
        </p>
      )}
      {broker.manager_excused && (
        <p className="text-emerald-300">
          Pausa abonada pelo Gerente do Plantão
        </p>
      )}
      {(broker.pause_started_at || broker.restriction_reason === "pause") && (
        <div className="flex flex-wrap gap-2">
          <label className="text-slate-400">
            Gerente do Plantão
            <input
              aria-label={`Gerente responsável pelo abono de ${broker.operational_name}`}
              className="block bg-slate-800 rounded p-2 text-white"
              value={manager}
              onChange={(e) => setManager(e.target.value)}
            />
          </label>
          <button
            disabled={saving || !manager.trim()}
            onClick={excuse}
            className="bg-indigo-700 disabled:opacity-40 rounded px-3 py-2 self-end"
          >
            Abonar e retornar
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
