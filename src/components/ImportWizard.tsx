"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type PreviewRow = {
  rowNumber: number;
  outcome: "IMPORTED" | "FLAGGED" | "REJECTED" | "DUPLICATE" | "EMPTY";
  reasons: string[];
  messages: string[];
  raw: string;
};
type Summary = {
  total: number;
  imported: number;
  flagged: number;
  rejected: number;
  duplicate: number;
  empty: number;
  normalizedWhitespace: number;
};

const OUTCOME_STYLE: Record<PreviewRow["outcome"], string> = {
  IMPORTED: "bg-emerald-100 text-emerald-800",
  FLAGGED: "bg-amber-100 text-amber-800",
  REJECTED: "bg-red-100 text-red-700",
  DUPLICATE: "bg-slate-200 text-slate-600",
  EMPTY: "bg-slate-100 text-slate-400",
};

export function ImportWizard({ groupId }: { groupId: string }) {
  const router = useRouter();
  const [csv, setCsv] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [preview, setPreview] = useState<{ summary: Summary; rows: PreviewRow[] } | null>(null);
  const [filter, setFilter] = useState<string>("ALL");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setPreview(null);
    const text = await file.text();
    setCsv(text);
    setFilename(file.name);

    setBusy(true);
    const res = await fetch(`/api/groups/${groupId}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: text }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not validate the file.");
      return;
    }
    setPreview(await res.json());
  }

  async function confirm() {
    if (!csv) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/groups/${groupId}/import/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv, filename: filename || "upload.csv" }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Import failed.");
      return;
    }
    const { batchId } = await res.json();
    router.push(`/groups/${groupId}/imports/${batchId}`);
    router.refresh();
  }

  const shown = preview?.rows.filter((r) => filter === "ALL" || r.outcome === filter) ?? [];

  return (
    <div className="mt-6">
      <label className="block cursor-pointer rounded-xl border-2 border-dashed border-slate-300 bg-white p-8 text-center hover:border-emerald-400">
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
        <span className="font-medium text-slate-700">
          {busy && !preview ? "Validating…" : "Choose a CSV file"}
        </span>
        <p className="mt-1 text-xs text-slate-500">Validation happens first — nothing is saved yet.</p>
      </label>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {preview && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold">Preview — every row accounted for</h2>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            {(
              [
                ["ALL", preview.summary.total, "All rows"],
                ["IMPORTED", preview.summary.imported, "Will import"],
                ["FLAGGED", preview.summary.flagged, "Import + flag"],
                ["REJECTED", preview.summary.rejected, "Rejected"],
                ["DUPLICATE", preview.summary.duplicate, "Duplicates"],
                ["EMPTY", preview.summary.empty, "Empty"],
              ] as const
            ).map(([key, count, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`rounded-full px-3 py-1 font-medium ${
                  filter === key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"
                }`}
              >
                {label}: {count}
              </button>
            ))}
          </div>
          {preview.summary.normalizedWhitespace > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              {preview.summary.normalizedWhitespace} row(s) required whitespace normalization.
            </p>
          )}

          <div className="mt-4 max-h-96 overflow-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Outcome</th>
                  <th className="px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((r) => (
                  <tr key={r.rowNumber}>
                    <td className="px-3 py-2 align-top text-slate-400">{r.rowNumber}</td>
                    <td className="px-3 py-2 align-top">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${OUTCOME_STYLE[r.outcome]}`}>
                        {r.outcome}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <code className="block break-all text-xs text-slate-500">{r.raw}</code>
                      {r.messages.map((m, i) => (
                        <p key={i} className="mt-0.5 text-xs text-slate-700">
                          {m}
                        </p>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={confirm}
            disabled={busy}
            className="mt-4 w-full rounded-md bg-emerald-600 py-2.5 font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy
              ? "Importing…"
              : `Confirm import (${preview.summary.imported + preview.summary.flagged} rows)`}
          </button>
        </div>
      )}
    </div>
  );
}
