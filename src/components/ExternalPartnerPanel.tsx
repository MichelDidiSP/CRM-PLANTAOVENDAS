import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  createPartnerIntake,
  reservePartnerUnit,
  savePartnerSale,
} from "@/lib/queue/pauseAndPartnersStore";
import type {
  PartnerIntake,
  PartnerReservation,
} from "@/lib/queue/pauseAndPartners";
const inputStyle = "block w-full bg-slate-800 rounded-lg p-2 mt-1 text-white";
export default function ExternalPartnerPanel({
  managementOnly = false,
  callsOnly = false,
  intakeRedirected = false,
}: {
  managementOnly?: boolean;
  callsOnly?: boolean;
  intakeRedirected?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PartnerIntake[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    id: crypto.randomUUID(),
    partner_name: "",
    company: "",
    creci: "",
    client_first_name: "",
    arrival: "accompanied" as PartnerIntake["arrival"],
    manager_target: "partnerships" as PartnerIntake["manager_target"],
  });
  async function load() {
    const { data, error } = await supabase
      .from("external_partner_intakes")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      setError(String(error.message));
      return;
    }
    setRows((data ?? []) as PartnerIntake[]);
  }
  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (intakeRedirected) return;
    setSaving(true);
    setError("");
    try {
      await createPartnerIntake(draft);
      setDraft({
        ...draft,
        id: crypto.randomUUID(),
        partner_name: "",
        company: "",
        creci: "",
        client_first_name: "",
      });
      setOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  async function acknowledge(id: string) {
    const { error } = await supabase
      .from("external_partner_intakes")
      .update({ manager_status: "acknowledged" })
      .eq("id", id);
    if (error) setError(error.message);
    else await load();
  }
  return (
    <section className="bg-slate-900 border border-sky-500/30 rounded-2xl p-5 mb-6 space-y-4">
      <div className="flex justify-between gap-3">
        <h2 className="text-lg font-bold text-sky-300">Parceria externa</h2>
        {!managementOnly && !callsOnly && !intakeRedirected && (
          <button
            className="bg-sky-700 rounded-lg px-4 py-2"
            onClick={() => setOpen(!open)}
          >
            Cadastrar parceria
          </button>
        )}
      </div>
      {intakeRedirected && <p className="text-sm text-sky-300">Para nova visita de parceria, use o formulário da Recepção abaixo.</p>}
      {open && !intakeRedirected && (
        <form
          onSubmit={submit}
          className="grid md:grid-cols-2 gap-4 text-sm text-slate-300"
        >
          <label>
            Nome do corretor externo
            <input
              className={inputStyle}
              required
              value={draft.partner_name}
              onChange={(e) =>
                setDraft({ ...draft, partner_name: e.target.value })
              }
            />
          </label>
          <label>
            Empresa ou Autônomo
            <input
              className={inputStyle}
              placeholder="Autônomo"
              value={draft.company}
              onChange={(e) => setDraft({ ...draft, company: e.target.value })}
            />
          </label>
          <label>
            CRECI
            <input
              className={inputStyle}
              required
              value={draft.creci}
              onChange={(e) => setDraft({ ...draft, creci: e.target.value })}
            />
          </label>
          <label>
            Apenas o primeiro nome do cliente
            <input
              className={inputStyle}
              required
              value={draft.client_first_name}
              onChange={(e) =>
                setDraft({ ...draft, client_first_name: e.target.value })
              }
            />
          </label>
          <label>
            Chegada
            <select
              className={inputStyle}
              value={draft.arrival}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  arrival: e.target.value as PartnerIntake["arrival"],
                })
              }
            >
              <option value="accompanied">
                Cliente acompanhado do parceiro
              </option>
              <option value="before_partner">
                Cliente chegou antes do parceiro
              </option>
            </select>
          </label>
          <label>
            Acionar
            <select
              className={inputStyle}
              value={draft.manager_target}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  manager_target: e.target
                    .value as PartnerIntake["manager_target"],
                })
              }
            >
              <option value="partnerships">Gerente de Parcerias</option>
              <option value="general">Gerente Geral (Incorporadora)</option>
            </select>
          </label>
          <button
            disabled={saving}
            className="bg-sky-700 rounded-lg p-3 md:col-span-2"
          >
            Registrar e chamar gerente
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {rows
        .filter((row) => !callsOnly || row.manager_status === "pending")
        .map((row) => (
          <article
            key={row.id}
            className="border border-slate-700 rounded-xl p-4 space-y-2"
          >
            <p className="font-medium">
              {row.client_first_name} · {row.partner_name} · {row.company} ·
              CRECI {row.creci}
            </p>
            <p
              className={
                row.manager_status === "pending"
                  ? "text-amber-300"
                  : "text-emerald-300"
              }
            >
              {row.manager_status === "pending"
                ? "Chamada pendente"
                : "Chamada recebida"}{" "}
              ·{" "}
              {row.manager_target === "partnerships"
                ? "Gerente de Parcerias"
                : "Gerente Geral (Incorporadora)"}
            </p>
            {managementOnly && row.manager_status === "pending" && (
              <button
                className="bg-emerald-700 rounded px-3 py-2"
                onClick={() => acknowledge(row.id)}
              >
                Confirmar recebimento
              </button>
            )}
            {managementOnly && <PartnerSale intakeId={row.id} />}
          </article>
        ))}
      {!rows.length && (
        <p className="text-slate-400 text-sm">Nenhuma chamada de parceria.</p>
      )}
    </section>
  );
}
function PartnerSale({ intakeId }: { intakeId: string }) {
  const [reservation, setReservation] = useState<PartnerReservation | null>(
    null,
  );
  const [unit, setUnit] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let mounted = true;
    supabase
      .from("external_partner_reservations")
      .select("*")
      .eq("intake_id", intakeId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) setError(error.message);
        if (data) {
          setReservation(data as PartnerReservation);
          setName(data.customer_full_name ?? "");
          setPhone(data.customer_phone ?? "");
        }
      });
    return () => {
      mounted = false;
    };
  }, [intakeId]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    setSaved(false);
    try {
      if (reservation) {
        await savePartnerSale(reservation.id, name, phone);
        setSaved(true);
      } else setReservation(await reservePartnerUnit(intakeId, unit));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      onSubmit={submit}
      className="border-t border-slate-700 pt-3 mt-3 space-y-3 text-sm"
    >
      {reservation ? (
        <>
          <h3 className="text-emerald-300">
            Vendas · unidade reservada {reservation.unit_reference} · comissão
            100% do parceiro
          </h3>
          <label className="block">
            Nome completo do cliente
            <input
              className={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block">
            Telefone do cliente
            <input
              className={inputStyle}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
        </>
      ) : (
        <label className="block">
          Reserva de unidade
          <input
            className={inputStyle}
            placeholder="Empreendimento / torre / unidade"
            required
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          />
        </label>
      )}
      <button disabled={saving} className="bg-indigo-700 rounded px-3 py-2">
        {reservation ? "Salvar dados da venda" : "Registrar reserva"}
      </button>
      {saved && (
        <p role="status" className="text-emerald-300">
          Dados da venda salvos.
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
