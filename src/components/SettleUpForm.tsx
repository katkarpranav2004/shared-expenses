"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function SettleUpForm({
  groupId,
  members,
  suggested,
}: {
  groupId: string;
  members: { id: string; name: string }[];
  suggested: Record<string, number>; // toUserId -> cents I currently owe them
}) {
  const router = useRouter();
  const [toUserId, setToUserId] = useState(members[0]?.id ?? "");
  const [amount, setAmount] = useState(
    members[0] && suggested[members[0].id] ? centsToInput(suggested[members[0].id]) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onPick(id: string) {
    setToUserId(id);
    setAmount(suggested[id] ? centsToInput(suggested[id]) : "");
    setWarn(null);
  }

  function checkOverpay(value: string, target: string) {
    const owed = suggested[target] ?? 0;
    const cents = Math.round(parseFloat(value || "0") * 100);
    // UI warning only — the server accepts any positive amount (DECISIONS.md #11).
    setWarn(
      owed > 0 && cents > owed
        ? "That's more than you currently owe them — the direction of the debt will flip."
        : owed === 0 && cents > 0
          ? "You don't currently owe them anything — this will make them owe you."
          : null,
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch(`/api/groups/${groupId}/settlements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toUserId,
        amount,
        date: form.get("date"),
        note: form.get("note") || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not record the settlement.");
      return;
    }
    router.refresh();
  }

  if (members.length === 0) {
    return <p className="mt-2 text-sm text-slate-500">No one else to settle with yet.</p>;
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <label className="block text-sm">
        <span className="font-medium">I paid</span>
        <select
          value={toUserId}
          onChange={(e) => onPick(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
        >
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="font-medium">Amount ($)</span>
        <input
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            checkOverpay(e.target.value, toUserId);
          }}
          required
          inputMode="decimal"
          placeholder="0.00"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium">Date</span>
        <input
          name="date"
          type="date"
          required
          defaultValue={new Date().toISOString().slice(0, 10)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium">Note (optional)</span>
        <input name="note" maxLength={200} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
      </label>
      {warn && <p className="text-sm text-amber-600">{warn}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        disabled={busy}
        className="w-full rounded-md bg-emerald-600 py-2 font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {busy ? "Recording…" : "Record payment"}
      </button>
    </form>
  );
}
