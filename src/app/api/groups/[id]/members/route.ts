import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requireActiveMember } from "@/lib/authz";

const schema = z.object({ email: z.string().trim().toLowerCase().email() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: groupId } = await params;
  const guard = await requireActiveMember(groupId);
  if ("error" in guard) return jsonError(guard.error, "Not allowed.", guard.status);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("INVALID_INPUT", "A valid email is required.", 400);

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user) {
    return jsonError(
      "USER_NOT_FOUND",
      "No registered user with that email. They need to sign up first.",
      404,
    );
  }

  const existing = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: user.id } },
  });
  if (existing && !existing.leftAt) {
    return jsonError("ALREADY_MEMBER", `${user.name} is already a member.`, 409);
  }

  if (existing) {
    // Rejoin: clear left_at. Documented MVP limitation — the gap is forgotten
    // (DECISIONS.md #5); membership-timing checks use the original joined_at.
    await prisma.groupMember.update({
      where: { id: existing.id },
      data: { leftAt: null },
    });
  } else {
    await prisma.groupMember.create({ data: { groupId, userId: user.id } });
  }
  return Response.json({ ok: true }, { status: 201 });
}
