import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ImportWizard } from "@/components/ImportWizard";

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: groupId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await prisma.groupMember.findFirst({
    where: { groupId, userId: session.user.id, leftAt: null },
  });
  if (!membership) notFound();

  const batches = await prisma.importBatch.findMany({
    where: { groupId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Import expenses from CSV</h1>
      <p className="mt-2 text-sm text-slate-600">
        Expected columns:{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
          date, description, amount, paid_by, split_type, participants, splits
        </code>
        . Participants are separated by <code className="rounded bg-slate-100 px-1">;</code> and
        matched by name or email. For EXACT/PERCENTAGE splits use{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">Name=value;Name=value</code>.{" "}
        <a href="/sample-import.csv" download className="text-emerald-700 underline">
          Download a sample file
        </a>
        . Nothing is saved until you confirm the preview, and re-uploading the same file never
        double-imports.
      </p>

      <ImportWizard groupId={groupId} />

      {batches.length > 0 && (
        <div className="mt-10">
          <h2 className="text-lg font-semibold">Previous imports</h2>
          <ul className="mt-2 space-y-2">
            {batches.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/groups/${groupId}/imports/${b.id}`}
                  className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm hover:border-emerald-400"
                >
                  <span className="font-medium">{b.filename}</span>
                  <span className="text-slate-500">
                    {b.createdAt.toISOString().slice(0, 10)} · {b.importedRows + b.flaggedRows}{" "}
                    imported / {b.rejectedRows} rejected / {b.duplicateRows} duplicates
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
