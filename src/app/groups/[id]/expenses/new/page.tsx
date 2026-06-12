import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ExpenseForm } from "@/components/ExpenseForm";

export default async function NewExpensePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: groupId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await prisma.groupMember.findFirst({
    where: { groupId, userId: session.user.id, leftAt: null },
  });
  if (!membership) notFound();

  const members = await prisma.groupMember.findMany({
    where: { groupId, leftAt: null },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { joinedAt: "asc" },
  });

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-bold">Add expense</h1>
      <ExpenseForm
        groupId={groupId}
        currentUserId={session.user.id}
        members={members.map((m) => ({ id: m.user.id, name: m.user.name }))}
      />
    </div>
  );
}
