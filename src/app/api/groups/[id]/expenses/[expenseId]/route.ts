import { prisma } from "@/lib/db";
import { jsonError, requireActiveMember } from "@/lib/authz";
import { buildExpense, expenseSchema } from "@/lib/expenseInput";

async function loadAndAuthorize(groupId: string, expenseId: string) {
  const guard = await requireActiveMember(groupId);
  if ("error" in guard) return { fail: jsonError(guard.error, "Not allowed.", guard.status) };

  const expense = await prisma.expense.findFirst({ where: { id: expenseId, groupId } });
  if (!expense) return { fail: jsonError("NOT_FOUND", "Expense not found.", 404) };

  // Only the payer or a group admin may modify history.
  if (expense.paidById !== guard.userId && guard.membership.role !== "ADMIN") {
    return { fail: jsonError("FORBIDDEN", "Only the payer or an admin can change this expense.", 403) };
  }
  return { expense };
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; expenseId: string }> },
) {
  const { id: groupId, expenseId } = await params;
  const got = await loadAndAuthorize(groupId, expenseId);
  if ("fail" in got) return got.fail;

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

  // Replace splits wholesale inside the transaction — balances are derived,
  // so consistency needs no compensating writes.
  await prisma.$transaction([
    prisma.expenseSplit.deleteMany({ where: { expenseId } }),
    prisma.expense.update({
      where: { id: expenseId },
      data: {
        description: built.expense.description,
        amountCents: built.expense.amountCents,
        originalAmountCents: built.expense.originalAmountCents,
        currency: built.expense.currency,
        fxRateBp: built.expense.fxRateBp,
        date: built.expense.date,
        paidById: built.expense.paidById,
        splitType: built.expense.splitType,
        splits: { create: built.expense.splits },
      },
    }),
  ]);
  return Response.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; expenseId: string }> },
) {
  const { id: groupId, expenseId } = await params;
  const got = await loadAndAuthorize(groupId, expenseId);
  if ("fail" in got) return got.fail;

  // Splits cascade (onDelete: Cascade).
  await prisma.expense.delete({ where: { id: expenseId } });
  return Response.json({ ok: true });
}
