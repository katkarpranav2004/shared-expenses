# DECISIONS.md

Every consequential decision, with the road not taken. Format: Problem → Options →
Pros/Cons → Choice → Reason.

---

## 1. Tech stack: Next.js full-stack vs separate frontend/backend

**Problem:** Ship a polished, publicly deployed app with auth, DB, and non-trivial
server logic in days, and be able to explain every layer.

**Options:**
| Option | Pros | Cons |
|---|---|---|
| **Next.js (App Router) + Prisma + Postgres** | one repo, one deploy (Vercel), SSR pages look professional, TypeScript end-to-end, huge documentation surface | server logic lives in route handlers (less "classic backend" to show); some interviewers prefer explicit servers |
| React (Vite) + Express + Prisma | explicit, classic 3-tier; very explainable | two deploys, CORS, two configs — time spent on plumbing, not product |
| Django + templates | batteries included, admin for free | weaker fit for the interactive split UI; two languages if any JS is needed |

**Choice:** Next.js full-stack.
**Reason:** The grading risk in this assignment is *money math and import policy*, not
infrastructure. The stack that minimizes plumbing time maximizes time on what's graded.
The "classic backend" concern is mitigated by keeping all domain logic in plain,
framework-free TypeScript modules (`lib/balances.ts`, `lib/import/validate.ts`) that are
unit-tested in isolation — in the interview I can show the business core with zero
Next.js in it.

---

## 2. Money representation: integer cents vs DECIMAL vs FLOAT

**Problem:** $100 split 3 ways must come back as exactly $100.

**Options:**
| Option | Pros | Cons |
|---|---|---|
| **Integer cents (INT)** | exact arithmetic in every language layer, trivial invariant checks, no driver surprises | display layer must format; sub-cent currencies need rework |
| DECIMAL(12,2) | exact in Postgres, idiomatic SQL | JS drivers return it as *string*; one careless `parseFloat` reintroduces float math in the app layer |
| FLOAT/DOUBLE | none worth listing | `0.1 + 0.2 ≠ 0.3`; disqualifying for money |

**Choice:** Integer cents everywhere; convert at the display boundary only.
**Reason:** The dangerous layer is not Postgres — it's JavaScript between the DB and the
screen. Cents-as-int makes the safe path the only path. (Interview note: DECIMAL is a
fine answer *for the column*; the argument is about what happens after the driver.)

---

## 3. Balances: derived on read vs stored balance table

**Problem:** Show "who owes whom" per group.

**Options:**
| Option | Pros | Cons |
|---|---|---|
| **Derive from expenses + settlements on every read** | single source of truth, edits/deletes free, zero drift, `Σ net == 0` checkable | O(rows in group) per read |
| Stored `balances` table updated on write | O(1) reads | every write path (create/edit/delete/import/settle) must update it correctly, in the same txn, forever; one missed path = silent corruption |
| Materialized view / cache | middle ground | invalidation complexity for no need at this scale |

**Choice:** Derive on read.
**Reason:** A group has hundreds of expenses, not millions — one indexed aggregate query.
Stored balances are a *write-amplification and correctness tax* paid to solve a read
problem we don't have. If scale ever demands it: incremental materialization behind the
same interface, verified against the derived number.

---

## 4. Split-sum invariant: where is it enforced?

**Problem:** `SUM(expense_splits.share_cents) == expenses.amount_cents` must always hold,
but a CHECK constraint can't span rows.

**Options:** service layer inside a transaction (chosen) · deferred constraint trigger in
Postgres · trust the client (never).
**Choice:** Service layer recomputes splits from raw inputs server-side and writes
expense + splits in one transaction; client-sent share values are treated as *proposals*
and re-validated.
**Reason:** A deferred trigger is the theoretically stronger guard but is harder to
write, test, and explain; the service layer is the single write path in this app (no
other writers exist), so the practical guarantee is equivalent. I can defend the trigger
as the right v2 if other writers (e.g., a second service) ever appear.

---

## 5. Membership model: soft leave with timestamps vs row deletion

**Problem:** Members join and leave, but historical expenses must keep meaning.

**Options:** delete the membership row (history breaks: old splits point at "ghost"
members) · `is_active` boolean (loses *when*) · **`joined_at` + nullable `left_at`**
(chosen) · full stint history (one row per join/leave episode).
**Choice:** `joined_at`/`left_at` on a unique (group,user) row; rejoin clears `left_at`.
**Reason:** Timestamps are what the CSV anomaly checks need (A13 membership-timing
requires *dates*, not booleans). Full stint history is the correct general model but
its only benefit over ours is preserving the gap on rejoin — a documented, acceptable
MVP limitation rather than a schema complication.

---

## 6. Leaving with unpaid balance: block vs allow

**Problem:** What happens when someone with a non-zero balance tries to leave?

**Options:** block until settled (chosen) · allow, keep debts attached to inactive member ·
allow and redistribute their debts (never — rewrites history).
**Choice:** Block with "settle up first," matching Splitwise's own behavior.
**Reason:** An inactive member with live debt creates a zombie ledger no one can act on.
Blocking converts a data-integrity problem into a one-click user action (record a
settlement, then leave). The "allow + keep" option is defensible for hostile-exit cases;
noted as a v2 admin override.

---

## 7. CSV import: partial-with-report vs all-or-nothing

**Problem:** A 500-row file with 6 bad rows.

**Options:** abort on first error · import valid rows, report the rest (chosen) ·
import everything best-effort with guesses.
**Choice:** Two-phase: validate **all** rows with nothing written, show preview, then
commit valid rows in one transaction; persist a per-row report.
**Reason:** All-or-nothing punishes the user for the file's worst row; best-effort
guessing violates the global principle (SCOPE.md §5) that we never silently alter money
or identity. The two-phase shape also gives the assignment's required Import Report a
natural home as a first-class DB entity rather than a log line.

---

## 8. Import idempotency: row hashing vs natural keys vs nothing

**Problem:** User uploads the same file twice (timeout, double-click).

**Options:** nothing (double debts — disqualifying) · natural unique key on
(date,payer,amount,description) as a DB constraint (blocks *legitimate* identical
expenses entered via the UI) · **hash check scoped to the import pipeline** (chosen).
**Choice:** `sha256` of the normalized row, stored on `import_rows`, checked against all
prior batches in the group; UI-created expenses are exempt.
**Reason:** Idempotency is an *import* property, not a domain property — two genuinely
identical dinners can exist, but the same CSV line must not import twice. Scoping the
mechanism to the pipeline encodes exactly that distinction.

---

## 9. Auth: NextAuth credentials + JWT sessions vs hand-rolled vs OAuth

**Problem:** Required login module; auth depth is not the grading focus.

**Choice:** NextAuth Credentials provider, bcrypt cost 12, JWT session strategy in an
HTTP-only SameSite cookie.
**Reason:** Hand-rolled session/token code is where take-homes grow vulnerabilities
(timing-unsafe compares, missing cookie flags). OAuth adds provider setup time and
complicates local review for graders. JWT-vs-DB sessions: DB sessions allow revocation,
which this app doesn't need; JWT removes a table and a query per request.
**Known tradeoff to state in interview:** JWT sessions can't be revoked server-side
before expiry; acceptable here, would revisit for anything with admin/permission churn.

---

## 10. Database: PostgreSQL vs MySQL vs SQLite

**Choice:** PostgreSQL on Neon.
**Reason:** Assignment requires relational. Postgres wins on: free serverless hosting
that pairs with Vercel (Neon), `CHECK` constraints and arrays (used by
`import_rows.reasons`), and being the strongest default answer to "why this DB?".
SQLite was tempting for zero setup but public deployment on serverless makes a hosted
DB necessary anyway. MySQL: no disqualifier, just no advantage.

---

## 11. Settlements: free-form payments vs debt-bounded payments

**Problem:** Should the app reject a settlement larger than the current debt?

**Choice:** Any positive amount between two active members is accepted; overpayment
simply flips the pair's direction. The UI *pre-fills* the owed amount and warns on
overpayment, but the server doesn't reject it.
**Reason:** Balances are derived, so an overpayment is not corruption — it's a true
statement ("A paid B $50") with a consistent consequence. Rejecting it would make the
app refuse to record reality. The warn-but-allow split puts strictness in the UI and
truth in the ledger.

---

## 12. Debt simplification: default view vs opt-in toggle

**Choice:** Pairwise (raw) debts are the default; greedy min-cash-flow simplification is
an opt-in, display-only toggle that never writes anything.
**Reason:** Simplification changes *who pays whom* relative to the actual social debts —
surprising as a default ("why do I owe Carol? I never split anything with Carol").
Keeping it display-only means the ledger remains an immutable record of facts.

---

## 13. Validation library: zod at every boundary

**Choice:** zod schemas shared between API input validation and CSV row validation.
**Reason:** One definition of "what a valid expense is" used by both entry paths (UI and
import) — the alternative is two drifting validators, which is exactly how an import
path lets in data the UI would have rejected.
