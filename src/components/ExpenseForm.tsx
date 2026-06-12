"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Member = { id: string; name: string };
type SplitType = "EQUAL" | "EXACT" | "PERCENTAGE";

// Client-side preview ONLY. The server recomputes everything from raw inputs;
// nothing computed here is trusted or persisted (DECISIONS.md #4).
function previewCents(s: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(s.trim())) return null;
  const [w, f = ""] = s.trim().split(".");
  return parseInt(w, 10) * 100 + parseInt(f.padEnd(2, "0") || "0", 10);
}

export function ExpenseForm({
  groupId,
  currentUserId,
  members,
}: {
  groupId: string;
  currentUserId: string;
  members: Member[];
}) {
  const router = useRouter();
  const [splitType, setSplitType] = useState<SplitType>("EQUAL");
  const [amount, setAmount] = useState("");
  const [paidById, setPaidById] = useState(currentUserId);
  const [selected, setSelected] = useState<Set<string>>(new Set(members.map((m) => m.id)));
  const [exact, setExact] = useState<Record<string, string>>({});
  const [percents, setPercents] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const participants = members.filter((m) => selected.has(m.id));
  const amountCents = previewCents(amount);

  const remainder = useMemo(() => {
    if (amountCents === null) return null;
    if (splitType === "EXACT") {
      let sum = 0;
      for (const m of participants) {
        const c = previewCents(exact[m.id] ?? "");
        if (c === null && (exact[m.id] ?? "") !== "") return null;
        sum += c ?? 0;
      }
      return amountCents - sum;
    }
    if (splitType === "PERCENTAGE") {
      let bp = 0;
      for (const m of participants) {
        const v = (percents[m.id] ?? "").trim();
        if (v && !/^\d+(\.\d{1,2})?$/.test(v)) return null;
        const [w, f = ""] = v.split(".");
        bp += v ? parseInt(w, 10) * 100 + parseInt(f.padEnd(2, "0") || "0", 10) : 0;
      }
      return 10000 - bp; // remaining basis points
    }
    return 0;
  }, [splitType, amountCents, participants, exact, percents]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch(`/api/groups/${groupId}/expenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: form.get("description"),
        amount,
        date: form.get("date"),
        paidById,
        splitType,
        participantIds: participants.map((m) => m.id),
        exact: splitType === "EXACT" ? exact : undefined,
        percents: splitType === "PERCENTAGE" ? percents : undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not save the expense.");
      return;
    }
    router.push(`/groups/${groupId}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Description</span>
        <input
          name="description"
          required
          maxLength={200}
          placeholder="Dinner at Beach Shack"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-medium">Amount ($)</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            inputMode="decimal"
            placeholder="100.00"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Date</span>
          <input
            name="date"
            type="date"
            required
            defaultValue={new Date().toISOString().slice(0, 10)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
      </div>

      <label className="block">
        <span className="text-sm font-medium">Paid by</span>
        <select
          value={paidById}
          onChange={(e) => setPaidById(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
        >
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id === currentUserId ? `${m.name} (you)` : m.name}
            </option>
          ))}
        </select>
      </label>

      <div>
        <span className="text-sm font-medium">Split</span>
        <div className="mt-1 flex gap-1 rounded-lg bg-slate-100 p-1">
          {(["EQUAL", "EXACT", "PERCENTAGE"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSplitType(t)}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium ${
                splitType === t ? "bg-white shadow-sm" : "text-slate-500"
              }`}
            >
              {t === "EQUAL" ? "Equally" : t === "EXACT" ? "Exact amounts" : "Percentages"}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="text-sm font-medium">Participants</span>
        <ul className="mt-2 space-y-2">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={() => toggle(m.id)}
                className="h-4 w-4"
              />
              <span className="flex-1">{m.name}</span>
              {splitType === "EXACT" && selected.has(m.id) && (
                <input
                  value={exact[m.id] ?? ""}
                  onChange={(e) => setExact({ ...exact, [m.id]: e.target.value })}
                  placeholder="0.00"
                  inputMode="decimal"
                  className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right text-sm"
                />
              )}
              {splitType === "PERCENTAGE" && selected.has(m.id) && (
                <div className="flex items-center gap-1">
                  <input
                    value={percents[m.id] ?? ""}
                    onChange={(e) => setPercents({ ...percents, [m.id]: e.target.value })}
                    placeholder="0"
                    inputMode="decimal"
                    className="w-20 rounded-md border border-slate-300 px-2 py-1 text-right text-sm"
                  />
                  <span className="text-sm text-slate-500">%</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {splitType === "EXACT" && remainder !== null && remainder !== 0 && amountCents !== null && (
        <p className={`text-sm ${remainder > 0 ? "text-amber-600" : "text-red-600"}`}>
          {remainder > 0
            ? `$${(remainder / 100).toFixed(2)} left to assign.`
            : `Assigned $${(-remainder / 100).toFixed(2)} too much.`}
        </p>
      )}
      {splitType === "PERCENTAGE" && remainder !== null && remainder !== 0 && (
        <p className={`text-sm ${remainder > 0 ? "text-amber-600" : "text-red-600"}`}>
          {remainder > 0
            ? `${(remainder / 100).toFixed(2)}% left to assign.`
            : `${(-remainder / 100).toFixed(2)}% too much.`}
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        disabled={busy || participants.length === 0}
        className="w-full rounded-md bg-emerald-600 py-2.5 font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save expense"}
      </button>
    </form>
  );
}
