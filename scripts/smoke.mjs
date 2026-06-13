// End-to-end smoke test against a running dev server seeded with "Flat 4B".
// Run: node scripts/smoke.mjs
// Verifies the real expenses_export.csv import end to end: anomaly handling,
// currency conversion, settlement reclassification, idempotency, and that the
// balances page renders (which runs the Σ net == 0 integrity assertion).

import { readFileSync } from "node:fs";

const BASE = "http://localhost:3000";
const jar = new Map();

function setCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1);
    if (v === "" || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k);
    else jar.set(k, v);
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    redirect: "manual",
    ...opts,
    headers: { cookie: cookieHeader(), ...(opts.headers ?? {}) },
  });
  setCookies(res);
  return res;
}

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

async function login(email, password) {
  jar.clear();
  const { csrfToken } = await (await req("/api/auth/csrf")).json();
  await req("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email, password }),
  });
  return (await (await req("/api/auth/session")).json())?.user ?? null;
}

const user = await login("aisha@example.com", "password123");
check("login as Aisha", user?.email === "aisha@example.com");

const dash = await (await req("/dashboard")).text();
const groupId = dash.match(/\/groups\/([a-z0-9]+)/)?.[1];
check("Flat 4B group present", !!groupId);

const csv = readFileSync(new URL("../public/expenses_export.csv", import.meta.url), "utf8");

// Preview.
const preview = await (
  await req(`/api/groups/${groupId}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv }),
  })
).json();
const s = preview.summary;
console.log("  preview summary:", JSON.stringify(s));
check("every row accounted for", s.imported + s.flagged + s.rejected + s.duplicate + s.reclassified + s.empty === s.total, JSON.stringify(s));
check("settlement reclassified (Rohan paid Aisha back)", s.reclassified >= 1, `reclassified=${s.reclassified}`);
check("at least one exact duplicate skipped (Marina)", s.duplicate >= 1, `duplicate=${s.duplicate}`);
check("USD rows converted", s.convertedCurrency >= 3, `converted=${s.convertedCurrency}`);
check("several rows rejected (precision/zero/110%/unknown)", s.rejected >= 3, `rejected=${s.rejected}`);
check("several rows flagged for review", s.flagged >= 5, `flagged=${s.flagged}`);

// Confirm commit.
const confirm = await (
  await req(`/api/groups/${groupId}/import/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv, filename: "expenses_export.csv" }),
  })
).json();
check("import committed (batch id)", !!confirm.batchId, JSON.stringify(confirm));

// Idempotent re-preview.
const preview2 = await (
  await req(`/api/groups/${groupId}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv }),
  })
).json();
check("re-import is idempotent (0 new expenses/settlements)",
  preview2.summary.imported === 0 && preview2.summary.flagged === 0 && preview2.summary.reclassified === 0,
  JSON.stringify(preview2.summary));

// Balances page renders => Σ net == 0 assertion passed on real data.
const balances = await req(`/groups/${groupId}?tab=balances`);
check("balances tab renders (Σ net == 0 held with refund + settlements + USD)", balances.status === 200, `status ${balances.status}`);

// Report download.
const report = await req(`/api/groups/${groupId}/imports/${confirm.batchId}?format=csv`);
check("import report CSV downloads", report.status === 200 && (report.headers.get("content-type") ?? "").includes("text/csv"));

console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
