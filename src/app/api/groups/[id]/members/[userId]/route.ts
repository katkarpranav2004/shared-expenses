import { prisma } from "@/lib/db";
import { jsonError, requireActiveMember } from "@/lib/authz";
import { getUserNetInGroup } from "@/lib/groupService";
import { formatCents } from "@/lib/money";

// Leave the group (self only in MVP). Blocked while the member's net balance
// is non-zero — a departed member with live debt is a ledger nobody can act
// on (DECISIONS.md #6). Soft-leave: sets left_at, never deletes the row.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const { id: groupId, userId: targetUserId } = await params;
  const guard = await requireActiveMember(groupId);
  if ("error" in guard) return jsonError(guard.error, "Not allowed.", guard.status);

  if (guard.userId !== targetUserId) {
    return jsonError("FORBIDDEN", "You can only remove yourself.", 403);
  }

  const net = await getUserNetInGroup(groupId, targetUserId);
  if (net !== 0) {
    const msg =
      net < 0
        ? `You still owe ${formatCents(-net)} in this group. Settle up before leaving.`
        : `The group still owes you ${formatCents(net)}. Settle up before leaving.`;
    return jsonError("UNSETTLED_BALANCE", msg, 409);
  }

  await prisma.groupMember.update({
    where: { groupId_userId: { groupId, userId: targetUserId } },
    data: { leftAt: new Date() },
  });
  return Response.json({ ok: true });
}
