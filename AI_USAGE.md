# AI_USAGE.md

## Tools Used

| Tool | Used for |
|---|---|
| Claude Code (Claude Fable 5) | planning, document drafting, schema design, code generation, test generation, this incident log |
| GitHub Copilot | (if used during build — log here) |

## Working Method

AI output is treated like a junior engineer's PR: nothing lands without being read,
questioned, and usually edited. Concretely:
1. Domain logic (balance engine, CSV validator) is **unit-tested with hand-computed
   expected values** — tests are written/verified by me against arithmetic done on paper,
   so AI can't grade its own homework.
2. Every AI-proposed schema/policy decision got a "what are the alternatives and why
   not them?" follow-up; the survivors are in DECISIONS.md.
3. This file logs every case where AI output was wrong or risky, found during review.

## Key Prompts (abridged)

1. *"Analyze the assignment, identify hidden requirements recruiters are testing, list
   all CSV anomalies likely present and why each matters"* → seeded SCOPE.md.
2. *"For every anomaly: detection logic, user message, action, why, alternatives
   considered"* → anomaly catalog format.
3. *"Design the schema for dynamic membership where historical expenses must survive
   members leaving"* → `joined_at`/`left_at` model.
4. *"Act as the interviewer and attack every decision"* → INTERVIEW_PREP.md drills.

## Incident Log — incorrect or risky AI output

> Entries 1–4 occurred during the planning phase (verifiable in the chat transcript /
> doc history). Entries 5–10 are the **highest-risk failure modes identified up front**;
> each is converted into a guard (test, constraint, or review rule) *before* coding, and
> this log is updated with actual occurrences during the build. Final submission will
> contain only verified incidents.

### 1. Wrong sign in the balance formula (occurred: planning)
- **What:** First draft of DESIGN.md stated `net = Σ paid − Σ share + Σ settlements received`, which double-counts in the wrong direction — receiving a settlement must *decrease* your net (your credit was consumed), paying one must *increase* it.
- **Detected:** manual re-derivation with a 2-person example (A pays $10 expense split equally; B settles $5; both nets must hit 0).
- **Correction:** formula fixed to `+ settlements paid − settlements received`; the `Σ net == 0` invariant added as a code assertion so this class of error fails loudly forever.

### 2. Anomaly policies drafted without the real CSV (occurred: planning)
- **What:** AI produced a confident anomaly catalog (column names, formats) for a file it had never seen — plausible-sounding specifics that could be silently wrong.
- **Detected:** noticed the catalog asserted column names as fact.
- **Correction:** SCOPE.md §3 now carries an explicit "written before seeing the file" assumption banner, policies are keyed to anomaly *classes*, and the validator is a pure function so the column mapping is one isolated change.

### 3. Proposed unique constraint that blocks legitimate data (occurred: planning)
- **What:** An early dedup idea was a DB unique index on (date, payer, amount, description) — which would also reject two genuinely identical UI-entered expenses (two same-priced coffees, same day).
- **Detected:** walked through the "two coffees" counterexample.
- **Correction:** idempotency moved to the import pipeline only (row hash on `import_rows`), per DECISIONS.md #8.

### 4. Git repository scoped to the entire home directory (occurred: setup)
- **What:** the working folder inherited a stray git repo rooted at `C:/Users/acer` — committing AI-generated scaffolding from here would have staged the whole user profile.
- **Detected:** AI flagged it from `git status` output paths before the first commit.
- **Correction:** fresh repo initialized at the project root; stray home-dir `.git` flagged for manual deletion.

### 5. Floating-point money (guarded)
- **Risk:** AI code samples habitually write `const share = amount / 3` on float dollars.
- **Guard:** all money is integer cents by schema and type (`amountCents: number` with a lint-able naming convention); unit test asserts `100.00 / 3` splits to `[3334, 3333, 3333]` summing exactly.

### 6. `parseFloat` on user/CSV input (guarded)
- **Risk:** `parseFloat("45.50abc")` returns `45.5` — AI-generated parsers accept garbage.
- **Guard:** strict regex parse (`A3` in SCOPE.md) with tests for `"1.2.3"`, `"abc"`, `"$1,200.50"`, `"12,50"`.

### 7. JS `Date` rolling invalid dates (guarded)
- **Risk:** `new Date("2024-02-30")` silently becomes March 1 in generated code — a *silent data change* on import.
- **Guard:** date validation re-serializes the parsed date and compares to input; test case `2024-02-30` must REJECT, not import as 2024-03-01.

### 8. Authorization holes in generated route handlers (guarded)
- **Risk:** AI scaffolds CRUD routes that check *authentication* but not *membership* — any logged-in user could read another group's expenses by ID.
- **Guard:** a single `requireActiveMember(groupId, session)` helper that every group route must call; review checklist item per route; test hits a foreign group's endpoint expecting 403.

### 9. Split recomputation trusting client values (guarded)
- **Risk:** generated expense-create handlers persist client-sent split amounts directly — a tampered request could store splits that don't sum to the total.
- **Guard:** server recomputes splits from raw inputs (DECISIONS.md #4); test posts a malicious payload (splits sum ≠ total) and expects `SPLIT_SUM_MISMATCH`.

### 10. Hallucinated library APIs (expected, will log instances)
- **Risk:** AI invents Prisma/NextAuth options that don't exist (e.g., plausible-but-fake `prisma.$transaction` flags or NextAuth callback names), which compile-fail at best and silently no-op at worst.
- **Guard:** TypeScript strict mode + every generated config option checked against the installed version's docs; instances logged here as found.

### 11. Off-by-one in largest-remainder distribution (expected, will log instances)
- **Risk:** the classic generated bug distributes `remainder` cents starting at index 1 or distributes `n − remainder` — sums still *look* right in the happy path.
- **Guard:** property-style test: for 1,000 random (amount, n) pairs, assert Σ shares == amount and max(share) − min(share) ≤ 1.
