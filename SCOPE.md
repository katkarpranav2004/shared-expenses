# SCOPE.md

> Rewritten against the **real** `public/expenses_export.csv` (42 data rows) and the
> updated assignment. Supersedes the version written against an assumed file. This is
> both the **anomaly log** (every data problem + policy) and the **database schema**.

---

## 1. The flatmate scenario (what the data represents)

Aisha, Rohan, Priya, Meera share a flat from Feb 2026. Dev joins for a Goa trip in March
(part of it paid in USD). Kabir (Dev's friend) joins for a single day. Meera moves out end
of March; Sam moves in mid-April. The CSV is their messy spreadsheet export.

Each flatmate's stated need maps to a feature:
- **Aisha** — "one number per person" → simplified per-person net + who-pays-whom.
- **Rohan** — "show which expenses make up what I owe" → per-expense balance drill-down.
- **Priya** — "a dollar isn't a rupee" → real multi-currency with documented conversion.
- **Sam** — "March shouldn't affect me" → membership-timing checks by date.
- **Meera** — "approve anything deleted/changed" → preview-and-confirm import; nothing
  silently altered; flagged rows surfaced for human resolution.

---

## 2. In scope

Auth · groups · dynamic membership with history (join/leave dates) · expenses with
**EQUAL / EXACT(=unequal) / PERCENTAGE / SHARE(ratio)** splits · **multi-currency
(INR base, USD converted at a documented rate)** · derived balances (per-person net,
pairwise, simplified, and per-expense breakdown) · settlements · CSV import with full
anomaly detection → preview → transactional commit → persisted, downloadable **Import
Report** · idempotent re-import · public deployment (Railway) · relational DB (Postgres).

## 3. Out of scope (declared)

Live FX rates (one documented snapshot rate, stored per converted expense for
reproducibility) · OAuth / password reset · receipts, comments, notifications ·
real-time updates · mobile apps · per-stint rejoin history (one membership row per
user with `joined_at`/`left_at`; documented in DECISIONS #5).

---

## 4. Database schema (PostgreSQL via Prisma)

Money is **integer minor units** (paise for INR, cents for USD). Every expense stores its
**original** amount+currency (what the user entered, for display + audit) and a **base**
amount in INR paise (what all balance math uses). `★` marks fields added for the real CSV.

| Table | Key columns | Purpose |
|---|---|---|
| `users` | id, email (unique), name, password_hash | identity |
| `groups` | id, name, description, base_currency★ (`INR`), created_by_id | a flat/trip; one base currency |
| `group_members` | id, group_id, user_id, role, **joined_at, left_at (nullable)** | membership over time; soft-leave preserves history; `@@unique(group_id,user_id)` |
| `expenses` | id, group_id, paid_by_id, description, **original_amount_cents★, currency★, amount_cents (BASE INR), fx_rate_bp★**, date (Date), split_type (EQUAL/EXACT/PERCENTAGE/**SHARE★**), notes★, import_row_id (unique, nullable), created_at | one expense; INVARIANT below |
| `expense_splits` | id, expense_id, user_id, share_cents (BASE INR) | per-participant share; `@@unique(expense_id,user_id)`; cascade delete |
| `settlements` | id, group_id, from_user_id, to_user_id, amount_cents (BASE INR), original_amount_cents★, currency★, date, note | payments incl. settlement-logged-as-expense rows |
| `import_batches` | id, group_id, uploaded_by_id, filename, total/imported/flagged/rejected/duplicate/empty counts | one upload |
| `import_rows` | id, batch_id, row_number, raw_data, row_hash, outcome, reasons[] | per-row audit; every source row recorded with its verbatim line |

**Invariants**
- `SUM(expense_splits.share_cents) == expenses.amount_cents` — enforced in the service
  layer inside a transaction (a CHECK can't span rows; DECISIONS #4).
- DB CHECKs: `amount_cents > 0` (expenses, settlements), `share_cents >= 0`,
  `from_user_id <> to_user_id` (settlements).
- Per group, `Σ net == 0` in base currency — asserted in code on every balance read.

**Why base + original (the multi-currency core):** balances must sum to zero, which is
impossible if rows are in different currencies. We convert to one base (INR) at import
using a documented snapshot rate, store the rate per expense so the number is
reproducible and auditable, and keep the original for display ("$540" not "₹44,820").

---

## 5. Anomaly catalog — every problem in the real CSV

Outcomes: **REJECT** (not imported, reported) · **FLAG** (imported, marked for human
review) · **DUPLICATE** (skipped) · **NORMALIZE** (auto-corrected, noted) · **RECLASSIFY**
(imported as a different entity, e.g. settlement). Row numbers are 1-based data rows
(header excluded). Codes are shared with the API, the report, and tests.

| # | Code | Where (rows) | Detection | Action | Why (and alternative) |
|---|---|---|---|---|---|
| 1 | `DATE_FORMAT_DDMMYYYY` | all | primary format is `DD-MM-YYYY`, not ISO | NORMALIZE to ISO | The file's own convention; rejecting all 42 rows would be absurd. (Alt: require ISO — rejected, hostile.) |
| 2 | `DATE_AMBIGUOUS` | 33 (`04-05-2026`), 26 (`Mar-14`) | `Mar-14` lacks a year / non-DD-MM; `04-05` is valid DD-MM (May 4) but sits out of sequence between March and April rows | FLAG (import): `Mar-14`→`2026-03-14` (year inferred from file), `04-05-2026`→`2026-05-04` | Both are recoverable; a human should eyeball them. (Alt: reject — loses real expenses.) |
| 3 | `EXACT_DUPLICATE` | 5 vs 4 (Marina Bites) | same date+payer+amount; description differs only by case/punctuation | DUPLICATE (skip row 5) | Re-logged identical dinner; idempotency. (Alt: import both — double-counts.) |
| 4 | `CONFLICTING_DUPLICATE` | 23 & 24 (Thalassa, ₹2400 vs ₹2450, diff payers) | same date, fuzzy-same description, **different payer AND amount** | FLAG **both** (import both, mark conflicting) | "Which row wins?" is a human call (notes even say "hers is wrong") and Meera demands approval before deletion — so we surface, never silently drop. (Alt: keep newer/keep specific — silently discards data.) |
| 5 | `AMOUNT_THOUSANDS_SEP` | 6 (`"1,200"`) | grouped thousands separator | NORMALIZE → 120000 paise | Unambiguous formatting. |
| 6 | `EXCESS_PRECISION` | 9 (`899.995`) | >2 decimal places (sub-paise) | REJECT | Rounding someone's money without consent; intent unclear. (Alt: round half-even + flag — documented runner-up.) |
| 7 | `ZERO_AMOUNT` | 29 (Swiggy `0`) | amount == 0 | REJECT | No financial effect; note even says "fixing later". |
| 8 | `NEGATIVE_AMOUNT` | 25 (Parasailing refund `-30 USD`) | amount < 0 | RECLASSIFY → negative adjustment / refund, FLAG | A refund is real money back; modelled as a refund expense (payer receives) or a settlement, surfaced for confirmation. (Alt: reject — loses a legitimate ₹/$ movement; import as-is — flips payer silently.) |
| 9 | `MISSING_PAYER` | 12 (House cleaning, empty paid_by) | required `paid_by` blank | REJECT | No defensible guess for who paid; note says "can't remember". |
| 10 | `MISSING_CURRENCY` | 27 (DMart, blank currency) | currency blank | NORMALIZE → group base (INR), FLAG | The flat's default is INR and every sibling row is INR; safe default, but flagged. (Alt: reject — overly strict for a known-default group.) |
| 11 | `FOREIGN_CURRENCY` (convert) | 19,20,22,25 (USD) | currency ≠ base | NORMALIZE: convert to INR at documented rate, store original+rate | Priya's explicit requirement; the sheet "pretends a dollar is a rupee" and we must not. (Alt: reject — fails the assignment; treat 1:1 — the exact bug we're fixing.) |
| 12 | `SETTLEMENT_AS_EXPENSE` | 13 (Rohan paid Aisha back), 36 (Sam deposit) | empty/`""` split_type + single counterpart, or description/notes signal a transfer | RECLASSIFY → settlement (from payer → counterpart) | The assignment's headline example; a payback is not consumption. Surfaced in report. (Alt: import as expense — corrupts balances.) |
| 13 | `PERCENT_SUM_MISMATCH` | 14 (Pizza, 30+30+30+20 = **110%**) | Σ% ≠ 100 (±0.01) | REJECT | Splits that don't sum to the whole change what each owes; can't guess the intended 100. (Alt: scale to 100 — invents numbers.) |
| 14 | `UNEQUAL_ALIAS` | 11 (birthday cake `unequal`) | `unequal` not a base type | NORMALIZE → EXACT | Same concept under another name; details sum to total (700+400+400=1500 ✓). |
| 15 | `SHARE_SPLIT` (new type) | 21 (scooters 1;2;1;2), 32 (April rent 2;1;1) | `share` ratio split | SUPPORTED (new split type) | Ratio splitting is a real, distinct method (someone took the bigger scooter / Meera's room); first-class support, not a workaround. |
| 16 | `SPLIT_TYPE_DETAIL_CONFLICT` | 39 (Furniture: type=equal but details `1;1;1;1`) | split_type says EQUAL yet split_details present | FLAG: honor EQUAL (the declared type), note the ignored details | Declared type wins over stray details; here both agree (equal quarters) so it's harmless, but the conflict is surfaced. (Alt: infer SHARE from details — overrides the user's stated intent.) |
| 17 | `UNKNOWN_PARTICIPANT_GUEST` | 22 (`Dev's friend Kabir`) | participant matches no member | REJECT row, hint "add Kabir as a member/guest, then re-import" | Auto-creating a user from free text forks identities; Kabir is a real one-day guest who should be added deliberately. Idempotent re-import then succeeds. (Alt: split among known 4 — changes everyone's share silently.) |
| 18 | `AMBIGUOUS_IDENTITY` | 10 (`Priya S`) | close to existing `Priya` (Levenshtein ≤ 2) but not exact | FLAG, hint closest match `Priya` | Could be Priya or a different person (Priya Sharma); merging identities silently is the most expensive error. Human confirms. |
| 19 | `WHITESPACE_CASE` | 8 (`priya`), 26 (`rohan `) | trailing space / lowercase vs member name | NORMALIZE (count once) | Formatting noise; failing to normalize would turn these into false UNKNOWN_USER. |
| 20 | `MEMBERSHIP_TIMING` | 35 (Meera in 02-04 groceries, after she left 31-03); Sam rows before mid-April join (37–40) | referenced member not active on the expense date (`joined_at ≤ date ≤ left_at`) | FLAG (import), exclude the inactive member's share OR surface for correction | Sam's explicit request: March/early-April shouldn't hit him; Meera shouldn't get post-move-out charges. Dates drive it. (Alt: reject — loses the real expense the active members still owe; auto-extend membership — rewrites history.) |
| 21 | `EMPTY_ROW` / trailing | EOF | all fields blank | skip, count | Spreadsheet noise, not data. |

**Every row is accounted for:** imported + flagged + rejected + duplicate + reclassified
+ empty == total. The report carries each source row's verbatim line so the user can
fix-and-reupload only the problems (idempotent).

---

## 6. Global import principles (say these out loud in the interview)

1. **The app is the system of record; the CSV is untrusted input.** Conflicts resolve in the app's favor.
2. **Never silently alter money or identity.** Whitespace/format/known-default normalizations are fine and noted; everything touching an amount, a person, or a currency is REJECT, FLAG, or RECLASSIFY with a reason.
3. **Convert currency, don't pretend.** USD → INR at a stored, documented rate; original preserved.
4. **Approval, not deletion** (Meera): the importer never deletes/edits existing data; conflicts and duplicates are flagged for the user to resolve in-app.
5. **Partial import + complete report** beats all-or-nothing; **idempotent** by row hash.
