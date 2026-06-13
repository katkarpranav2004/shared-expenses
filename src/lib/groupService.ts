import { prisma } from "./db";
import { computeNets, pairwiseDebts, simplifyDebts } from "./balances";

// One query bundle per group; balances are derived here on every read
// (DECISIONS.md #3 — no stored balances anywhere).
export async function getGroupBalances(groupId: string) {
  const [expenses, settlements, members] = await Promise.all([
    prisma.expense.findMany({
      where: { groupId },
      select: {
        paidById: true,
        amountCents: true,
        isRefund: true,
        splits: { select: { userId: true, shareCents: true } },
      },
    }),
    prisma.settlement.findMany({
      where: { groupId },
      select: { fromUserId: true, toUserId: true, amountCents: true },
    }),
    prisma.groupMember.findMany({
      where: { groupId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  ]);

  const nets = computeNets(expenses, settlements);
  return {
    nets,
    pairwise: pairwiseDebts(expenses, settlements),
    simplified: simplifyDebts(nets),
    members,
  };
}

export async function getUserNetInGroup(groupId: string, userId: string) {
  const { nets } = await getGroupBalances(groupId);
  return nets.get(userId) ?? 0;
}
