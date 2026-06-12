import { z } from "zod";
import { jsonError, requireActiveMember } from "@/lib/authz";
import { validateForGroup } from "@/lib/import/service";

const schema = z.object({
  csv: z.string().min(1).max(2_000_000), // ~2 MB guard for serverless body limits
});

// Phase 1 of 2: validate everything, write NOTHING. The client shows the
// preview and re-sends the file to /import/confirm.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: groupId } = await params;
  const guard = await requireActiveMember(groupId);
  if ("error" in guard) return jsonError(guard.error, "Not allowed.", guard.status);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("INVALID_INPUT", "Provide a CSV file under 2 MB.", 400);

  const result = await validateForGroup(groupId, parsed.data.csv);
  if (!result.ok) return jsonError("INVALID_FILE", result.fileError ?? "Unreadable file.", 422);

  return Response.json({
    summary: result.summary,
    rows: result.rows.map((r) => ({
      rowNumber: r.rowNumber,
      outcome: r.outcome,
      reasons: r.reasons,
      messages: r.messages,
      raw: r.raw,
    })),
  });
}
