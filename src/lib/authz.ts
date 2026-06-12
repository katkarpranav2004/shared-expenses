import type { Session } from "next-auth";
import type { GroupMember } from "@prisma/client";
import { auth } from "./auth";
import { prisma } from "./db";

export type MemberGuard =
  | { error: "UNAUTHENTICATED" | "FORBIDDEN"; status: 401 | 403 }
  | { session: Session; membership: GroupMember; userId: string };

// Authentication says who you are; this says what you can touch.
// Every group-scoped route/page calls this — the single chokepoint that
// prevents "any logged-in user can read any group by ID" (AI_USAGE.md #8).
export async function requireActiveMember(groupId: string): Promise<MemberGuard> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!session || !userId) return { error: "UNAUTHENTICATED", status: 401 };

  const membership = await prisma.groupMember.findFirst({
    where: { groupId, userId, leftAt: null },
  });
  if (!membership) return { error: "FORBIDDEN", status: 403 };

  return { session, membership, userId };
}

export function jsonError(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status });
}
