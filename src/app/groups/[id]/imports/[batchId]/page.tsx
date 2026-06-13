import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

const OUTCOME_STYLE: Record<string, string> = {
  IMPORTED: "bg-emerald-100 text-emerald-800",
  FLAGGED: "bg-amber-100 text-amber-800",
  REJECTED: "bg-red-100 text-red-700",
  DUPLICATE: "bg-slate-200 text-slate-600",
  RECLASSIFIED: "bg-sky-100 text-sky-800",
};

export default async function ImportReportPage({
  params,
}: {
  params: Promise<{ id: string; batchId: string }>;
}) {
  const { id: groupId, batchId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await prisma.groupMember.findFirst({
    where: { groupId, userId: session.user.id, leftAt: null },
  });
  if (!membership) notFound();

  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, groupId },
    include: {
      rows: { orderBy: { rowNumber: "asc" } },
      uploadedBy: { select: { name: true } },
    },
  });
  if (!batch) notFound();

  const cells = [
    ["Total rows", batch.totalRows],
    ["Imported", batch.importedRows],
    ["Flagged", batch.flaggedRows],
    ["→ Settlement", batch.reclassifiedRows],
    ["Rejected", batch.rejectedRows],
    ["Duplicates", batch.duplicateRows],
    ["Empty", batch.emptyRows],
  ] as const;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Import report</h1>
          <p className="text-sm text-slate-500">
            {batch.filename} · {batch.createdAt.toISOString().slice(0, 10)} · uploaded by{" "}
            {batch.uploadedBy.name}
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <a
            href={`/api/groups/${groupId}/imports/${batchId}?format=csv`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-100"
          >
            ⬇ CSV
          </a>
          <a
            href={`/api/groups/${groupId}/imports/${batchId}?format=json`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-100"
          >
            ⬇ JSON
          </a>
          <Link
            href={`/groups/${groupId}`}
            className="rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700"
          >
            Back to group
          </Link>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-7">
        {cells.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-3 text-center">
            <p className="text-xl font-bold">{value}</p>
            <p className="text-xs text-slate-500">{label}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Outcome</th>
              <th className="px-3 py-2">Reasons</th>
              <th className="px-3 py-2">Original row</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {batch.rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 align-top text-slate-400">{r.rowNumber}</td>
                <td className="px-3 py-2 align-top">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${OUTCOME_STYLE[r.outcome] ?? ""}`}
                  >
                    {r.outcome}
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-xs">{r.reasons.join(", ") || "—"}</td>
                <td className="px-3 py-2">
                  <code className="block break-all text-xs text-slate-500">{r.rawData}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
