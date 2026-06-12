import { prisma } from "@/lib/db";
import { jsonError, requireActiveMember } from "@/lib/authz";

// Import report download: ?format=csv | json (default json).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; batchId: string }> },
) {
  const { id: groupId, batchId } = await params;
  const guard = await requireActiveMember(groupId);
  if ("error" in guard) return jsonError(guard.error, "Not allowed.", guard.status);

  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, groupId }, // groupId in the filter: no cross-group reads by ID
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) return jsonError("NOT_FOUND", "Import batch not found.", 404);

  const format = new URL(req.url).searchParams.get("format") ?? "json";

  if (format === "csv") {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = [
      "row_number,outcome,reasons,original_row",
      ...batch.rows.map((r) =>
        [r.rowNumber, r.outcome, esc(r.reasons.join("; ")), esc(r.rawData)].join(","),
      ),
    ];
    return new Response(lines.join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="import-report-${batch.id}.csv"`,
      },
    });
  }

  return Response.json({
    batch: {
      id: batch.id,
      filename: batch.filename,
      createdAt: batch.createdAt,
      summary: {
        total: batch.totalRows,
        imported: batch.importedRows,
        flagged: batch.flaggedRows,
        rejected: batch.rejectedRows,
        duplicate: batch.duplicateRows,
        empty: batch.emptyRows,
      },
    },
    rows: batch.rows.map((r) => ({
      rowNumber: r.rowNumber,
      outcome: r.outcome,
      reasons: r.reasons,
      raw: r.rawData,
    })),
  });
}
