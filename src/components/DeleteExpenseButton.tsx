"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteExpenseButton({
  groupId,
  expenseId,
}: {
  groupId: string;
  expenseId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function del() {
    if (!confirm("Delete this expense? Balances will recalculate.")) return;
    setBusy(true);
    const res = await fetch(`/api/groups/${groupId}/expenses/${expenseId}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      alert(body?.error?.message ?? "Could not delete.");
      return;
    }
    router.refresh();
  }

  return (
    <button
      onClick={del}
      disabled={busy}
      className="mt-1 text-xs text-red-500 underline hover:text-red-700 disabled:opacity-50"
    >
      delete
    </button>
  );
}
