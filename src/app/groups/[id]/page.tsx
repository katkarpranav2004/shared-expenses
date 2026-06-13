import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getGroupBalances } from "@/lib/groupService";
import { formatMoney as formatCents, formatMoney } from "@/lib/currency";
import { AddMemberForm } from "@/components/AddMemberForm";
import { LeaveGroupButton } from "@/components/LeaveGroupButton";
import { DeleteExpenseButton } from "@/components/DeleteExpenseButton";
import { SettleUpForm } from "@/components/SettleUpForm";

export default async function GroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; simplify?: string }>;
}) {
  const { id: groupId } = await params;
  const { tab = "expenses", simplify } = await searchParams;

  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  // Authorization: caller must be an active member (page-level twin of
  // requireActiveMember — same rule, same query).
  const membership = await prisma.groupMember.findFirst({
    where: { groupId, userId, leftAt: null },
  });
  if (!membership) notFound();

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) notFound();

  const { nets, pairwise, simplified, members } = await getGroupBalances(groupId);
  const expenses = await prisma.expense.findMany({
    where: { groupId },
    include: {
      paidBy: { select: { name: true } },
      splits: { include: { user: { select: { name: true } } } },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 100,
  });
  const settlements = await prisma.settlement.findMany({
    where: { groupId },
    include: { from: { select: { name: true } }, to: { select: { name: true } } },
    orderBy: { date: "desc" },
    take: 50,
  });

  const nameOf = new Map(members.map((m) => [m.userId, m.user.name]));
  const activeMembers = members.filter((m) => !m.leftAt);
  const debts = simplify === "1" ? simplified : pairwise;
  const myNet = nets.get(userId) ?? 0;

  const tabs = [
    ["expenses", "Expenses"],
    ["balances", "Balances"],
    ["members", "Members"],
  ] as const;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{group.name}</h1>
          {group.description && <p className="text-sm text-slate-500">{group.description}</p>}
        </div>
        <div className="flex gap-2">
          <Link
            href={`/groups/${groupId}/expenses/new`}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            + Add expense
          </Link>
          <Link
            href={`/groups/${groupId}/import`}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100"
          >
            📥 Import CSV
          </Link>
        </div>
      </div>

      <div className="mt-6 flex gap-1 border-b border-slate-200">
        {tabs.map(([key, label]) => (
          <Link
            key={key}
            href={`/groups/${groupId}?tab=${key}`}
            className={`rounded-t-md px-4 py-2 text-sm font-medium ${
              tab === key
                ? "border border-b-0 border-slate-200 bg-white text-emerald-700"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {tab === "expenses" && (
        <div className="mt-4 space-y-3">
          {expenses.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500">
              No expenses yet.
            </p>
          )}
          {expenses.map((e) => (
            <div key={e.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">
                    {e.description}
                    {e.isRefund && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">refund</span>
                    )}
                  </p>
                  <p className="text-sm text-slate-500">
                    {e.date.toISOString().slice(0, 10)} · paid by {e.paidBy.name} ·{" "}
                    {e.splitType.toLowerCase()} split
                    {e.importRowId ? " · imported" : ""}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {e.splits.map((s) => `${s.user.name} ${formatCents(s.shareCents)}`).join(" · ")}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold">{formatCents(e.amountCents)}</p>
                  {e.currency !== "INR" && (
                    <p className="text-xs text-slate-400">
                      {formatMoney(e.originalAmountCents, e.currency)} @ 1 {e.currency} ={" "}
                      {formatMoney(e.fxRateBp)}
                    </p>
                  )}
                  {e.paidById === userId && <DeleteExpenseButton groupId={groupId} expenseId={e.id} />}
                </div>
              </div>
            </div>
          ))}
          {settlements.length > 0 && (
            <>
              <h3 className="pt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
                Settlements
              </h3>
              {settlements.map((s) => (
                <div key={s.id} className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
                  <span className="font-medium">{s.from.name}</span> paid{" "}
                  <span className="font-medium">{s.to.name}</span>{" "}
                  <span className="font-bold">{formatCents(s.amountCents)}</span>
                  <span className="text-slate-500"> · {s.date.toISOString().slice(0, 10)}</span>
                  {s.note && <span className="text-slate-500"> · {s.note}</span>}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {tab === "balances" && (
        <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <h3 className="font-semibold">Net balances</h3>
            <ul className="mt-2 space-y-2">
              {members
                .filter((m) => !m.leftAt || (nets.get(m.userId) ?? 0) !== 0)
                .map((m) => {
                  const net = nets.get(m.userId) ?? 0;
                  return (
                    <li
                      key={m.userId}
                      className="flex justify-between rounded-lg border border-slate-200 bg-white px-4 py-2"
                    >
                      <span>
                        {m.user.name}
                        {m.leftAt && <span className="text-xs text-slate-400"> (left)</span>}
                      </span>
                      <span
                        className={
                          net > 0 ? "font-medium text-emerald-700" : net < 0 ? "font-medium text-red-600" : "text-slate-500"
                        }
                      >
                        {net > 0 ? `is owed ${formatCents(net)}` : net < 0 ? `owes ${formatCents(-net)}` : "settled"}
                      </span>
                    </li>
                  );
                })}
            </ul>

            <div className="mt-6 flex items-center justify-between">
              <h3 className="font-semibold">{simplify === "1" ? "Simplified debts" : "Who owes whom"}</h3>
              <Link
                href={`/groups/${groupId}?tab=balances${simplify === "1" ? "" : "&simplify=1"}`}
                className="text-sm text-emerald-700 underline"
              >
                {simplify === "1" ? "Show actual debts" : "Simplify debts"}
              </Link>
            </div>
            {simplify === "1" && (
              <p className="mt-1 text-xs text-slate-500">
                Display-only: fewest payments that settle everyone. The ledger itself is unchanged.
              </p>
            )}
            <ul className="mt-2 space-y-2">
              {debts.length === 0 && <li className="text-sm text-slate-500">Everyone is settled up. 🎉</li>}
              {debts.map((d, i) => (
                <li key={i} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm">
                  <span className="font-medium">{nameOf.get(d.fromUserId)}</span> owes{" "}
                  <span className="font-medium">{nameOf.get(d.toUserId)}</span>{" "}
                  <span className="font-bold">{formatCents(d.amountCents)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="font-semibold">Settle up</h3>
            <p className="mt-1 text-xs text-slate-500">
              Records that you paid another member. Overpaying simply flips who owes whom.
            </p>
            <SettleUpForm
              groupId={groupId}
              members={activeMembers
                .filter((m) => m.userId !== userId)
                .map((m) => ({ id: m.userId, name: m.user.name }))}
              suggested={Object.fromEntries(
                pairwise
                  .filter((d) => d.fromUserId === userId)
                  .map((d) => [d.toUserId, d.amountCents]),
              )}
            />
          </div>
        </div>
      )}

      {tab === "members" && (
        <div className="mt-4 max-w-lg space-y-4">
          <ul className="space-y-2">
            {members.map((m) => (
              <li
                key={m.userId}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-2"
              >
                <div>
                  <p className="font-medium">
                    {m.user.name}
                    {m.role === "ADMIN" && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">admin</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500">
                    joined {m.joinedAt.toISOString().slice(0, 10)}
                    {m.leftAt && ` · left ${m.leftAt.toISOString().slice(0, 10)}`}
                  </p>
                </div>
                {m.userId === userId && !m.leftAt && (
                  <LeaveGroupButton groupId={groupId} userId={userId} settled={myNet === 0} />
                )}
              </li>
            ))}
          </ul>
          <div>
            <h3 className="font-semibold">Add a member</h3>
            <AddMemberForm groupId={groupId} />
          </div>
        </div>
      )}
    </div>
  );
}
