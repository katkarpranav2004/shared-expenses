import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requireActiveMember } from "@/lib/authz";
import { parseAmount } from "@/lib/money";

const schema = z.object({
  toUserId: z.string().min(1),
  amount: z.string().trim().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(200).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: groupId } = await params;
  const guard = await requireActiveMember(groupId);
  if ("error" in guard) return jsonError(guard.error, "Not allowed.", guard.status);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("INVALID_INPUT", "Invalid settlement.", 400);
  const { toUserId, note } = parsed.data;

  if (toUserId === guard.userId) {
    return jsonError("SELF_SETTLEMENT", "You can't settle with yourself.", 422);
  }
  const recipient = await prisma.groupMember.findFirst({
    where: { groupId, userId: toUserId, leftAt: null },
  });
  if (!recipient) {
    return jsonError("UNKNOWN_USER", "The recipient is not an active member of this group.", 422);
  }

  const amount = parseAmount(parsed.data.amount);
  if (!amount.ok) return jsonError(amount.code, "Enter a valid positive amount.", 422);

  const [y, m, d] = parsed.data.date.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.toISOString().slice(0, 10) !== parsed.data.date) {
    return jsonError("INVALID_DATE", "That date does not exist.", 422);
  }

  // Any positive amount is accepted — overpaying flips the pair's direction;
  // the ledger records what actually happened (DECISIONS.md #11).
  await prisma.settlement.create({
    data: {
      groupId,
      fromUserId: guard.userId,
      toUserId,
      amountCents: amount.cents,
      date,
      note: note || null,
    },
  });
  return Response.json({ ok: true }, { status: 201 });
}
