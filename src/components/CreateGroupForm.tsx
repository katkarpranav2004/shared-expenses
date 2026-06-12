"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CreateGroupForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        description: form.get("description") || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not create group.");
      return;
    }
    const { id } = await res.json();
    router.push(`/groups/${id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3">
      <input
        name="name"
        required
        maxLength={100}
        placeholder="Group name (e.g. Goa Trip)"
        className="w-full rounded-md border border-slate-300 px-3 py-2"
      />
      <input
        name="description"
        maxLength={500}
        placeholder="Description (optional)"
        className="w-full rounded-md border border-slate-300 px-3 py-2"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        disabled={busy}
        className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create group"}
      </button>
    </form>
  );
}
