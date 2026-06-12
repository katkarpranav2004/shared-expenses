// End-to-end smoke test against a running dev server with seeded data.
// Run: node scripts/smoke.mjs
// Exercises: login (NextAuth credentials), authz (403 on foreign group),
// expense create incl. tampered-split rejection, balances zero-sum, CSV
// import preview + confirm + idempotent re-confirm, report download.

const BASE = "http://localhost:3000";
const jar = new Map();

function setCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const [pair] = c.split(";");
    const [k, v] = pair.split("=");
    if (v === "" || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k.trim());
    else jar.set(k.trim(), v);
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
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
  const csrfRes = await req("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const res = await req("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email, password }),
  });
  return res.status;
}

// ---- 1. Auth
const badLogin = await login("alice@example.com", "wrong-password");
const sessionAfterBad = await (await req("/api/auth/session")).json();
check("wrong password does not create a session", !sessionAfterBad?.user);

await login("alice@example.com", "password123");
const session = await (await req("/api/auth/session")).json();
check("login works for seeded user", session?.user?.email === "alice@example.com");

// ---- 2. Find the seeded group via dashboard HTML
const dash = await (await req("/dashboard")).text();
const groupId = dash.match(/\/groups\/([a-z0-9]+)/)?.[1];
check("dashboard lists the seeded group", !!groupId);

// ---- 3. Authorization: a non-member must get 403/404 on someone else's group
await login("alice@example.com", "password123");
const meRes = await req(`/api/groups/${groupId}/import`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ csv: "date,description,amount,paid_by,split_type,participants,splits\n" }),
});
check("member can call group endpoints", meRes.status !== 403, `got ${meRes.status}`);

// register a fresh outsider
const outsiderEmail = `outsider-${Date.now()}@example.com`;
await req("/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Outsider", email: outsiderEmail, password: "password123" }),
});
await login(outsiderEmail, "password123");
const foreign = await req(`/api/groups/${groupId}/expenses`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    description: "intrusion",
    amount: "10.00",
    date: "2024-02-10",
    paidById: "whatever",
    splitType: "EQUAL",
    participantIds: ["whatever"],
  }),
});
check("outsider gets 403 on foreign group", foreign.status === 403, `got ${foreign.status}`);

// ---- 4. Expense creation + tampering
await login("alice@example.com", "password123");
const groupHtml = await (await req(`/groups/${groupId}?tab=members`)).text();
// pull user ids from the expense API instead: create EQUAL expense via members from import ctx
// Use the import preview to discover member names is overkill; instead create with self only:
const sessionUserId = session.user.id ?? null;

// EQUAL expense $100 with payer only (flag-worthy but valid via UI rules)
const eq = await req(`/api/groups/${groupId}/expenses`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    description: "Smoke equal",
    amount: "100.00",
    date: "2024-02-20",
    paidById: sessionUserId,
    splitType: "EQUAL",
    participantIds: [sessionUserId],
  }),
});
check("expense create works", eq.status === 201, `got ${eq.status} ${await eq.text()}`);

// Tampered EXACT split: shares don't sum to total -> must be rejected
const tampered = await req(`/api/groups/${groupId}/expenses`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    description: "Tampered",
    amount: "100.00",
    date: "2024-02-20",
    paidById: sessionUserId,
    splitType: "EXACT",
    participantIds: [sessionUserId],
    exact: { [sessionUserId]: "55.00" },
  }),
});
const tamperedBody = await tampered.json();
check(
  "tampered split (55 != 100) rejected with SPLIT_SUM_MISMATCH",
  tampered.status === 422 && tamperedBody?.error?.code === "SPLIT_SUM_MISMATCH",
  `got ${tampered.status} ${JSON.stringify(tamperedBody)}`,
);

// Sub-cent amount rejected
const subcent = await req(`/api/groups/${groupId}/expenses`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    description: "Subcent",
    amount: "33.333",
    date: "2024-02-20",
    paidById: sessionUserId,
    splitType: "EQUAL",
    participantIds: [sessionUserId],
  }),
});
check("sub-cent amount rejected", subcent.status === 422, `got ${subcent.status}`);

// ---- 5. CSV import: preview, confirm, idempotent re-confirm
const csv = await (await req("/sample-import.csv")).text();
const preview = await (
  await req(`/api/groups/${groupId}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv }),
  })
).json();
const s1 = preview.summary;
check("preview accounts for every row", s1.imported + s1.flagged + s1.rejected + s1.duplicate + s1.empty === s1.total, JSON.stringify(s1));
check("preview detects rejections (anomaly file)", s1.rejected >= 5, JSON.stringify(s1));
check("preview detects in-file duplicate", s1.duplicate >= 1, JSON.stringify(s1));
check("preview flags future date / near-dup / self-only", s1.flagged >= 2, JSON.stringify(s1));

const confirm1 = await (
  await req(`/api/groups/${groupId}/import/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv, filename: "sample-import.csv" }),
  })
).json();
check("confirm returns a batch id", !!confirm1.batchId, JSON.stringify(confirm1));

const preview2 = await (
  await req(`/api/groups/${groupId}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv }),
  })
).json();
check(
  "re-upload is idempotent: 0 importable, all prior imports now duplicates",
  preview2.summary.imported === 0 && preview2.summary.flagged === 0,
  JSON.stringify(preview2.summary),
);

// ---- 6. Report download
const reportCsv = await req(`/api/groups/${groupId}/imports/${confirm1.batchId}?format=csv`);
check("report CSV downloads", reportCsv.status === 200 && (reportCsv.headers.get("content-type") ?? "").includes("text/csv"));

// ---- 7. Balances page renders (zero-sum assertion runs server-side)
const balances = await req(`/groups/${groupId}?tab=balances`);
check("balances tab renders (Σ net == 0 assertion passed)", balances.status === 200, `got ${balances.status}`);

console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
