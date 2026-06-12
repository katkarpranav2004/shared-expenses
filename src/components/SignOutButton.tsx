"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: "/" })}
      className="text-slate-600 hover:text-slate-900"
    >
      Sign out
    </button>
  );
}
