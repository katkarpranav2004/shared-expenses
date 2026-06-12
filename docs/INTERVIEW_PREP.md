# INTERVIEW_PREP.md — Question Bank with Model Answers

Drill until you can answer each *without reading the answer*. The interviewer's meta-
question behind all of these is the same: **did you make the decisions, or did the AI?**
Owning the tradeoffs in DECISIONS.md is the whole game.

---

## A. Database

**A1. Walk me through your schema. Why seven tables?**
Users, groups, and the join table `group_members` model identity and membership;
`expenses` + `expense_splits` model money in (header/detail, because one expense has N
participant shares — a classic 1:N that must not be denormalized into a CSV-ish column);
`settlements` models money back; `import_batches` + `import_rows` make the import report
a first-class, queryable entity instead of a log file. (That's eight — the trap in the
question; count them yourself, don't accept the premise.)

**A2. Why is there no balances table?**
Balances are a *derivation*, not a fact. Facts: who paid, who owed, who settled. Storing
derived state buys O(1) reads at the cost of every write path having to maintain it
forever, atomically. At group scale (hundreds of rows) the aggregate query is
milliseconds. And derived balances make edit/delete trivially consistent and give a free
integrity check: Σ net == 0, always. If reads ever became hot: incremental
materialization behind the same function signature, validated against the derived value.

**A3. Why integer cents and not DECIMAL?**
DECIMAL is exact *inside Postgres*, but the JS driver returns it as a string, and the
first careless `parseFloat` reintroduces binary floating point in the app layer. Integer
cents are exact in every layer with no discipline required. Tradeoff I accept: display
formatting responsibility, and a rework if we ever support zero-decimal or three-decimal
currencies (JPY, BHD).

**A4. How do you guarantee splits sum to the expense total?**
Two layers. The write path: the server ignores client-computed shares, recomputes splits
from raw inputs, and writes expense + splits in one transaction — there is exactly one
write path, and it can't produce a violation. The check layer: a CHECK constraint can't
span rows, so the DB-level alternative is a deferred constraint trigger; I judged it not
worth the complexity while the service layer is the only writer, and I can say precisely
when that judgment flips (a second writer appears).

**A5. A member leaves and you delete their membership row. What breaks?**
Their `expense_splits` rows now reference a user with no visible relationship to the
group — historical balances become uncomputable or misattributed. That's why leaving
sets `left_at` instead of deleting; history is append-only. Known limitation I'll volunteer:
one row per (group,user) means a rejoin clears `left_at` and forgets the gap; the full
fix is stint rows (one per join/leave episode), out of MVP scope.

**A6. What indexes did you add and why?**
Every FK (Postgres doesn't auto-index FKs): `expenses(group_id)`,
`expense_splits(expense_id)`, `settlements(group_id)`, plus `import_rows(row_hash)` for
the idempotency probe and the unique composite on `group_members(group_id, user_id)`.
Balance derivation reads all expenses for a group — `expenses(group_id)` is the one that
matters most.

**A7. Race condition: two members add expenses simultaneously. Problem?**
No — expenses are independent inserts; balances are derived at read time, so there's no
shared counter to race on. The race that *does* exist: concurrent "leave group" and "add
expense including that member" — handled because the leave check and the membership
check both run in transactions against the same rows; worst case is one of them fails
validation. This is a payoff of deriving balances: most classic races vanish.

---

## B. CSV Import & Anomalies

**B1. Why partial import instead of all-or-nothing?**
One bad row in 500 shouldn't block 499 good ones. The cost of partial is explaining what
happened — paid by the persisted per-row report (every row: outcome + reason + original
raw line). All-or-nothing is the right call when rows are interdependent (e.g., a ledger
where later rows reference earlier ones); these rows are independent expenses.

**B2. Your duplicate detection — why hash, why not a DB unique constraint?**
Because idempotency is an import property, not a domain property. Two genuinely
identical dinners can exist via the UI; the same CSV *line* must not import twice. A
domain-level unique constraint can't tell those apart — a pipeline-scoped row hash can.

**B3. Same payer, amount, date — different description. What do you do and why?**
FLAG and import (A12). Skipping risks destroying real data (two $4 coffees same day is
plausible); importing silently misses the most common export bug. Flagging delegates to
the human with context — and the report makes that delegation explicit, not a shrug.

**B4. The CSV says Sarah paid an expense dated after she left the group.**
REJECT (A13) — flows from a stated principle, not case-by-case vibes: the app is the
system of record, the CSV is untrusted input. Importing would assign debt our own
records say is impossible. The opposite policy (CSV authoritative, auto-extend
membership) is coherent for a *migration* import into an empty system; this import
targets a live group.

**B5. Amount is "33.333". You rejected it — isn't that hostile? You normalize "$1,200.50" — isn't that inconsistent?**
The line is *intent ambiguity about money*. A currency symbol and thousands separators
are formatting — the number is unambiguous. Sub-cent precision is not: it could be a
typo, a unit-rate × quantity artifact, or deliberate. My invariant is "never alter an
amount's value"; stripping `$` doesn't alter value, rounding 33.333 does. Runner-up I
considered: round half-even + FLAG — defensible, documented in SCOPE.md A4.

**B6. Why did you choose to reject unknown users instead of creating them?**
Auto-creating from a typo forks one human into two identities, and every balance
involving the fork is wrong forever — the most expensive class of error in the system.
Rejection costs a re-upload. Asymmetric costs ⇒ reject; the Levenshtein closest-match
hint in the report cuts the fix to seconds. Auto-create is right in one scenario —
bootstrap migration into an empty system — which this isn't.

**B7. 100k-row CSV. What breaks first?**
In order: serverless request body limit (move to direct-to-storage upload), request
timeout during validation (move validation to a background job, poll the batch status —
schema already supports it since batches are persisted entities), then memory if the
parser isn't streaming (it is — row-at-a-time validation, so memory is O(1) plus the
duplicate-hash set, which at 100k hashes is ~few MB and fine).

**B8. Re-upload the same file with one corrected row. What happens?**
The 1 corrected row imports (its hash changed); the rest report as DUPLICATE; totals
reconcile. This "fix-and-reupload" loop is the *designed* workflow — the report ships
raw lines so the user can edit exactly the rejects.

---

## C. Balance Calculation

**C1. $100, three people, equal split. Go.**
3334 + 3333 + 3333 cents. Largest-remainder: floor(10000/3)=3333 each, remainder 1 cent
to the first participant by stable user-id order. Properties: sums exactly, max spread
1 cent, deterministic — same input, same output, so re-imports and edits can't shuffle
who eats the cent.

**C2. Why deterministic? Who cares which person pays the extra cent?**
Reproducibility. If remainder assignment were random or insertion-order-dependent,
re-creating an identical expense (or replaying an import) could yield different splits —
duplicate detection by content hash would break, and tests would flake. Fairness across
many expenses argues for rotation; I chose auditability over cent-level fairness and can
say so.

**C3. Define "net balance" precisely. Prove the group sums to zero.**
`net(u) = Σ paid(u) − Σ share(u) + Σ settlementsPaid(u) − Σ settlementsReceived(u)`.
Each expense contributes +amount to its payer and −shares summing to exactly −amount
(split invariant) ⇒ net contribution 0. Each settlement is +x to one member, −x to
another ⇒ 0. Sum of zeros is zero. The code asserts it; a violation means data
corruption, and I'd rather crash a balance page than show wrong money.

**C4. A settles more than they owe B. Now what?**
The pair's direction flips — B owes A the difference. Allowed by design (DECISIONS.md
#11): the settlement is a true fact ("A paid B $50"), and since balances are derived,
recording truth keeps everything consistent. The UI warns; the ledger records.

**C5. Explain your debt simplification. Is greedy optimal?**
Greedy min-cash-flow: repeatedly match max debtor with max creditor, settle the smaller
absolute value, repeat. It always terminates in ≤ n−1 payments and minimizes total money
moved. Minimizing the *number* of transactions is the subtle part — greedy achieves
≤ n−1, but the true minimum is n − (number of subgroups whose nets independently sum to
zero), and finding those subgroups is subset-sum — NP-hard. So: greedy is a good
heuristic, optimal in money flow, near-optimal in transaction count, and it's
display-only — it never rewrites the ledger.

**C6. Member leaves, then you import an old expense dated while they were active.**
Imports fine — A13 checks membership *at the expense date*, not today. Their balance can
go non-zero again even though they left... which exposes a real edge: my leave rule
checked balance at leave time. Resolution I chose: the import-timing check uses dates,
and a departed member's balance can be reopened by legitimately backdated history; they
show in balances as "(left)" and can still settle. I'd rather surface this honestly than
pretend the edge doesn't exist. (Stricter alternative: REJECT historical imports
touching departed members — defensible, loses real history.)

---

## D. System Design & Security

**D1. Why Next.js full-stack — can you even call this a backend?**
The domain core (`lib/balances.ts`, `lib/import/validate.ts`) is plain TypeScript with
zero framework imports, unit-tested in isolation — that's the backend that matters, and
it would move to Express/NestJS unchanged. Next.js route handlers are the thin HTTP
layer around it. I optimized build time toward what's graded: money math and import
policy, not plumbing.

**D2. Where are your authorization checks?**
One helper — `requireActiveMember(groupId, session)` — called at the top of every
group-scoped route. Authentication says who you are; this says what you can touch.
Specifically tested: requesting a foreign group's expenses/balances/report by ID returns
403. (This is also AI_USAGE.md incident #8 — generated CRUD code habitually omits it.)

**D3. How do you prevent a tampered request from writing bad splits?**
Client split values are proposals. The server recomputes from raw inputs (amount,
participants, type, percentages) and validates before the transaction. Trusting client
math would let one crafted fetch violate the core invariant.

**D4. What happens when Vercel cold-starts mid-import confirm?**
The confirm is one DB transaction — it either committed or it didn't; no partial batch
can exist. The client retries safely because the pipeline is idempotent: already-
committed rows hash-match as DUPLICATE on retry. Idempotency wasn't just a CSV feature —
it's the crash-safety story.

**D5. Scale this to 1M users.**
Honest answer first: this design targets a take-home's scale and I'd change things in
order of measured pain, not speculatively. The order: (1) read path — derived balances
per group stay fine because groups stay small; the dashboard's "net across all my
groups" aggregate is the first query to cache or incrementally materialize. (2) import —
background jobs + object storage for files. (3) DB — connection pooling (Neon/pgBouncer)
before any talk of sharding; expenses partition naturally by group_id if it ever comes
to that. What I would *not* do: stored balances as step one — that's trading my
strongest correctness property for a read problem I haven't measured.

**D6. Why JWT sessions if they can't be revoked?**
Scale and threat model: no admin roles, no permission churn, short-lived sessions,
take-home scope. Revocation needs a session table — one more query per request for a
capability nothing here uses. I can name the moment this flips: the day there's a
"remove member's access NOW" requirement.

**D7. What's the worst bug that could ship in this app?**
A silent one in money math — wrong balances that *look* plausible. Everything in the
design bends toward making that loud: integer cents, the Σ net == 0 assertion, split-sum
recomputation server-side, deterministic rounding, and an import that refuses to guess.
Loud failures are recoverable; quiet corruption isn't.

---

## E. Curveballs (have one-liners ready)

- **"What would you cut if you had one day?"** UI polish and PERCENTAGE splits — never the report, never idempotency, never tests on the balance engine.
- **"What are you least proud of?"** The single-stint membership model — rejoin forgets the gap; I know the fix (stint rows) and chose scope over completeness, documented in DECISIONS.md #5.
- **"Did AI write this?"** AI drafted; I decided. Here's AI_USAGE.md — including the incident where it got the balance-formula sign wrong and how the Σ net == 0 assertion came out of that.
- **"Why should leaving require settling up?"** A departed member with live debt is a ledger nobody can act on. I turn a data-integrity problem into a one-click user action. Splitwise does the same.
- **"One thing you'd add with another week?"** Stint-based membership + a reconciliation view that recomputes every group's Σ net nightly and alerts on non-zero — cheap insurance against the worst-bug scenario above.
