import { z } from "zod";
import { jsonError, requireActiveMember } from "@/lib/authz";
import { commitImport, validateForGroup } from "@/lib/import/service";

const schema = z.object({
  csv: z.string().min(1).max(2_000_000),
  filename: z.string().trim().min(1).max(255),
});

// Phase 2 of 2: re-validate (the preview is advisory — DB state may have
// changed since; TOCTOU-safe) and commit valid rows in one transaction.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: groupId } = await params;
  const guard = await requireActiveMember(groupId);
  if ("error" in guard) return jsonError(guard.error, "Not allowed.", guard.status);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("INVALID_INPUT", "Provide a CSV file under 2 MB.", 400);

  const result = await validateForGroup(groupId, parsed.data.csv);
  if (!result.ok) return jsonError("INVALID_FILE", result.fileError ?? "Unreadable file.", 422);

  const batch = await commitImport(groupId, guard.userId, parsed.data.filename, result);
  return Response.json({ batchId: batch.id }, { status: 201 });
}
