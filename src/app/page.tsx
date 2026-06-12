import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function LandingPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <div className="py-16 text-center">
      <h1 className="text-4xl font-bold tracking-tight">
        Split expenses. <span className="text-emerald-600">Keep friendships.</span>
      </h1>
      <p className="mx-auto mt-4 max-w-xl text-lg text-slate-600">
        Track group expenses with equal, exact or percentage splits, see who owes
        whom down to the cent, settle up, and import your history from CSV — with
        every anomaly detected and reported.
      </p>
      <div className="mt-8 flex justify-center gap-4">
        <Link
          href="/register"
          className="rounded-lg bg-emerald-600 px-6 py-3 font-semibold text-white hover:bg-emerald-700"
        >
          Get started
        </Link>
        <Link
          href="/login"
          className="rounded-lg border border-slate-300 bg-white px-6 py-3 font-semibold text-slate-700 hover:bg-slate-100"
        >
          Log in
        </Link>
      </div>
      <div className="mx-auto mt-16 grid max-w-3xl grid-cols-1 gap-6 text-left sm:grid-cols-3">
        {[
          ["⚖️ Exact to the cent", "Integer-cent math with deterministic rounding. $100 ÷ 3 always comes back as $100."],
          ["👥 Members come and go", "Join and leave freely — history survives, and you settle up before you walk."],
          ["📥 CSV import that tells the truth", "Every row imported, flagged, rejected or deduplicated — with a downloadable report."],
        ].map(([title, body]) => (
          <div key={title} className="rounded-xl border border-slate-200 bg-white p-5">
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-2 text-sm text-slate-600">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
