import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { SignOutButton } from "@/components/SignOutButton";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shared Expenses",
  description: "Track group expenses, split fairly, settle up.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
            <Link href={session ? "/dashboard" : "/"} className="text-lg font-bold text-emerald-700">
              💸 Shared Expenses
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              {session?.user ? (
                <>
                  <span className="text-slate-500">{session.user.name}</span>
                  <SignOutButton />
                </>
              ) : (
                <>
                  <Link href="/login" className="text-slate-600 hover:text-slate-900">
                    Log in
                  </Link>
                  <Link
                    href="/register"
                    className="rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700"
                  >
                    Sign up
                  </Link>
                </>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
