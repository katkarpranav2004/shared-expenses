"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LeaveGroupButton({
  groupId,
  userId,
  settled,
}: {
  groupId: string;
  userId: string;
  settled: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function leave() {
    if (!confirm("Leave this group?")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/groups/${groupId}/members/${userId}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not leave the group.");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="text-right">
      <button
        onClick={leave}
        disabled={busy}
        title={settled ? "Leave this group" : "You must settle up before leaving"}
        className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
      >
        {busy ? "Leaving…" : "Leave group"}
      </button>
      {error && <p className="mt-1 max-w-48 text-xs text-red-600">{error}</p>}
    </div>
  );
}
