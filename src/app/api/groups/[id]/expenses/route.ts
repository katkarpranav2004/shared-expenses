import { prisma } from "@/lib/db";
import { jsonError, requireActiveMember } from "@/lib/authz";
import { buildExpense, expenseSchema } from "@/lib/expenseInput";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: groupId } = await params;
  const guard = await requireActiveMember(groupId);
  if ("error" in guard) return jsonError(guard.error, "Not allowed.", guard.status);

  const parsed = expenseSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input.", 400);
  }

  const active = await prisma.groupMember.findMany({
    where: { groupId, leftAt: null },
    select: { userId: true },
  });
  const built = buildExpense(parsed.data, new Set(active.map((m) => m.userId)));
  if (!built.ok) return jsonError(built.code, built.message, 422);

  // Expense + splits in one transaction: the split-sum invariant is never
  // observable as violated, even mid-write.
  const expense = await prisma.expense.create({
    data: {
      groupId,
      paidById: built.expense.paidById,
      description: built.expense.description,
      amountCents: built.expense.amountCents,
      date: built.expense.date,
      splitType: built.expense.splitType,
      splits: { create: built.expense.splits },
    },
  });

  return Response.json({ id: expense.id }, { status: 201 });
}
