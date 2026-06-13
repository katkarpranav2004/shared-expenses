import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getUserNetInGroup } from "@/lib/groupService";
import { formatMoney as formatCents } from "@/lib/currency";
import { CreateGroupForm } from "@/components/CreateGroupForm";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const memberships = await prisma.groupMember.findMany({
    where: { userId, leftAt: null },
    include: { group: { include: { _count: { select: { members: true, expenses: true } } } } },
    orderBy: { joinedAt: "desc" },
  });

  // N+1 by design at this scale: one aggregate per group card, hundreds of
  // rows each — fine. First thing to batch if the dashboard ever gets slow.
  const nets = await Promise.all(
    memberships.map((m) => getUserNetInGroup(m.groupId, userId)),
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">My groups</h1>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {memberships.map((m, i) => {
          const net = nets[i];
          return (
            <Link
              key={m.id}
              href={`/groups/${m.groupId}`}
              className="rounded-xl border border-slate-200 bg-white p-5 transition hover:border-emerald-400 hover:shadow-sm"
            >
              <div className="flex items-start justify-between">
                <h2 className="font-semibold">{m.group.name}</h2>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    net > 0
                      ? "bg-emerald-100 text-emerald-800"
                      : net < 0
                        ? "bg-red-100 text-red-700"
                        : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {net > 0
                    ? `you are owed ${formatCents(net)}`
                    : net < 0
                      ? `you owe ${formatCents(-net)}`
                      : "settled up"}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-500">
                {m.group._count.members} member{m.group._count.members === 1 ? "" : "s"} ·{" "}
                {m.group._count.expenses} expense{m.group._count.expenses === 1 ? "" : "s"}
              </p>
            </Link>
          );
        })}
        {memberships.length === 0 && (
          <p className="col-span-full rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500">
            No groups yet — create your first one below.
          </p>
        )}
      </div>

      <div className="mt-8 max-w-md">
        <h2 className="text-lg font-semibold">Create a group</h2>
        <CreateGroupForm />
      </div>
    </div>
  );
}
