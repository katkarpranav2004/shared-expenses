import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/authz";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return jsonError("UNAUTHENTICATED", "Log in first.", 401);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("INVALID_INPUT", "Group name is required.", 400);

  try {
    const group = await prisma.group.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description || null,
        createdById: session.user.id,
        members: { create: { userId: session.user.id, role: "ADMIN" } },
      },
    });
    return Response.json({ id: group.id }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/groups] Failed to create group:", err);
    return jsonError("INTERNAL", "Could not create group. Check server logs.", 500);
  }
}
