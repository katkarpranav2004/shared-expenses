# SCOPE.md

## 1. In Scope (MVP)

- Email/password auth (register, login, logout)
- Groups: create, view, add members by email, leave (with settle-first rule)
- Dynamic membership with full history (`joined_at` / `left_at`, never hard-deleted)
- Expenses: create/edit/delete with **EQUAL / EXACT / PERCENTAGE** splits
- Balances: per-member net, pairwise debts, optional simplified ("who pays whom") view
- Settlements: recorded as ledger entries; balances always derived, never stored
- CSV import: full pre-validation → preview → transactional commit → persisted,
  downloadable **Import Report**; idempotent re-upload
- Public deployment (Vercel + Neon Postgres)

## 2. Out of Scope (deliberately)

| Cut | Why it's safe to cut |
|---|---|
| Multi-currency | CSV/app assume one currency; currency column anomalies are still *detected* (rejected, not converted) |
| OAuth / email verification / password reset | auth depth isn't what's being graded; credentials + bcrypt covers the requirement |
| Recurring expenses, receipts, comments, notifications | feature breadth ≠ grading criteria; correctness of money math is |
| Real-time updates | refetch-on-navigation is fine at this scale |
| Per-stint rejoin history (multiple membership rows per user) | one row with `joined_at`/`left_at`; rejoining clears `left_at`. Documented limitation: a re-join forgets the gap. Acceptable for MVP, flagged in DECISIONS.md #5 |
| Mobile apps | responsive web only |

## 3. Assumptions about the CSV

> ⚠️ Written **before seeing the real file**. Each policy below is keyed to an anomaly
> *class*, not to specific column names, so it transfers. The detection layer is a
> pure function (`validateRow(raw) → {outcome, reasons[]}`) so adapting to the real
> header set is a mapping change, not a redesign.

Assumed shape: one expense per row with columns approximating
`date, group, description, amount, paid_by, split_type, participants[, splits/percentages]`.
If the real CSV includes settlements or users as separate sections/files, the same
pipeline applies per entity type.

## 4. Anomaly Policy Catalog

Outcomes: **REJECT** (row not imported, reported) · **FLAG** (imported, marked for
review in report) · **DUPLICATE** (skipped, reported) · **NORMALIZE** (auto-corrected,
correction noted in report). Every row gets exactly one outcome plus zero or more
reason codes. Nothing is ever silently dropped or silently altered — the report shows
the original raw line for every row.

---

### A1. `MALFORMED_ROW` — wrong column count / unparseable line
- **Detection:** CSV parser (RFC 4180-compliant, quoted-field aware) reports field-count mismatch vs header.
- **Message:** "Row 17: expected 7 columns, found 5 — row skipped."
- **Action:** REJECT.
- **Why:** Guessing which fields are missing risks attributing money to the wrong person. A wrong import is worse than a skipped row.
- **Alternatives considered:** best-effort positional guessing (rejected: silent misattribution); aborting whole import (rejected: one bad row shouldn't block 500 good ones).

### A2. `MISSING_REQUIRED_FIELD` — empty amount / payer / date / group
- **Detection:** after parsing, trim each required field; empty string ⇒ missing.
- **Message:** "Row 23: missing 'paid_by' — row skipped."
- **Action:** REJECT.
- **Why:** No defensible default exists for *who paid* or *how much*.
- **Alternatives:** defaulting date to today (rejected: corrupts temporal membership checks); prompting per row (rejected: unusable at 1000 rows).

### A3. `INVALID_AMOUNT` — non-numeric, `$1,200.50`, `1.2.3`, `abc`
- **Detection:** strict parse. Tolerant normalization first: strip one leading currency symbol and thousands separators, then require `^\d+(\.\d{1,2})?$`.
- **Message:** "Row 9: amount '12,50€' is not a valid amount — row skipped." / "Row 4: amount '$1,200.50' normalized to 1200.50."
- **Action:** NORMALIZE if it cleanly normalizes (noted in report); otherwise REJECT.
- **Why:** `$45.50` is unambiguous human formatting — rejecting it is pedantic. `12,50` (EU decimal comma) is ambiguous with thousands separators ⇒ reject rather than guess.
- **Alternatives:** reject all non-canonical (rejected: hostile to real exports); locale auto-detect (rejected: silent 100× errors when comma is misread).

### A4. `EXCESS_PRECISION` — `33.333`
- **Detection:** more than 2 decimal places after normalization.
- **Message:** "Row 12: amount 33.333 has sub-cent precision — row skipped."
- **Action:** REJECT.
- **Why:** Rounding someone's money without consent is the one thing an expenses app must never do silently; unlike a currency symbol, intent here is genuinely unclear (typo? rate × qty?).
- **Alternatives:** round half-even and FLAG (defensible — documented as the runner-up; chosen stricter option to keep "we never alter amounts" as a clean invariant).

### A5. `NEGATIVE_AMOUNT`
- **Detection:** parsed amount < 0.
- **Message:** "Row 31: negative amount −25.00 — row skipped. If this is a refund, record it as a settlement or as an expense paid by the other party."
- **Action:** REJECT.
- **Why:** A negative expense is semantically ambiguous: refund? correction? settlement? Each maps to a *different* ledger entry. Importing as-is would flip payer/ower silently.
- **Alternatives:** auto-convert to reversed expense (rejected: guesses intent); import as settlement (rejected: guesses harder).

### A6. `ZERO_AMOUNT`
- **Detection:** parsed amount == 0.
- **Message:** "Row 8: amount is 0.00 — row skipped (no financial effect)."
- **Action:** REJECT.
- **Why:** Zero rows carry no balance information and usually indicate export bugs; importing them adds noise to the feed.
- **Alternatives:** import as memo-only expense (rejected: schema CHECK `amount > 0` is a stronger guarantee than a special case).

### A7. `INVALID_DATE` — `2024-13-45`, `Feb 30`, `31/02/2024`, garbage
- **Detection:** strict ISO-8601 first; fall back to a small whitelist of unambiguous formats; reject anything ambiguous (`01/02/2024` is rejected unless the whole file is consistent with exactly one of DMY/MDY).
- **Message:** "Row 5: date '2024-02-30' is not a real date — row skipped."
- **Action:** REJECT (NORMALIZE with note when an unambiguous alt format parses).
- **Why:** Dates drive membership-timing checks (A12) — a misparsed date can turn a valid expense into a false anomaly and vice versa.
- **Alternatives:** permissive `Date.parse` (rejected: JS happily invents dates, e.g. rolls Feb 30 → Mar 1, a silent data change).

### A8. `FUTURE_DATE`
- **Detection:** parsed date > today (UTC, +1 day tolerance for timezone skew).
- **Message:** "Row 19: date 2027-01-05 is in the future — imported and flagged."
- **Action:** FLAG (import).
- **Why:** Future dates are *suspicious but not impossible* (pre-paid bookings, prepayments). Money fields are intact, so the balance math is sound; the report points a human at it.
- **Alternatives:** reject (rejected: legitimate prepayments exist); silently import (rejected: likely typo — 2027 for 2024 — deserves attention).

### A9. `UNKNOWN_USER` — payer or participant matches no known user
- **Detection:** case-insensitive, trimmed match against group members (by email if the CSV has emails, else by exact display name).
- **Message:** "Row 14: payer 'Jhon Smith' does not match any member of this group — row skipped. Closest match: 'John Smith'."
- **Action:** REJECT, with closest-match hint (Levenshtein ≤ 2) in the report.
- **Why:** Auto-creating users from typos forks one human into two identities and corrupts every subsequent balance. The hint makes the fix a 10-second edit.
- **Alternatives:** auto-create placeholder users and FLAG (the strongest competitor — right for a *bootstrap* import into an empty system; wrong here because import targets an existing group whose membership is the source of truth); fuzzy auto-match (rejected: "Jon"/"John" may genuinely be two people).

### A10. `UNKNOWN_GROUP` (if the CSV is multi-group)
- **Detection:** group name/id matches nothing the importing user belongs to.
- **Message:** "Row 3: group 'Ski Trip 2024' not found — row skipped."
- **Action:** REJECT.
- **Why:** Creating groups as a side effect of import bypasses membership and authorization rules.
- **Alternatives:** auto-create group (rejected: who are its members?). In the MVP the import is launched *from inside a group*, which makes this anomaly structural: any group column must match the current group.

### A11. `DUPLICATE_ROW` — exact duplicate within file or vs prior imports
- **Detection:** `sha256` of the normalized tuple (date, payer, amount, description, participants, split data). Checked against the current batch *and* the `import_rows` table from previous batches.
- **Message:** "Row 27: identical to row 4 — skipped." / "Row 27: already imported in batch #2 on 2026-06-01 — skipped."
- **Action:** DUPLICATE (skip, report).
- **Why:** Re-uploading a file after a browser hiccup must not double everyone's debts. Idempotency is the difference between a toy and a tool.
- **Alternatives:** import with FLAG (rejected: breaks idempotency, the worst failure mode here); block whole file (rejected: punishes a partial re-export).

### A12. `NEAR_DUPLICATE` — same payer + amount + date, different description
- **Detection:** secondary hash excluding description.
- **Message:** "Row 33: same payer, amount and date as row 30 ('Dinner' vs 'Diner') — imported and flagged as possible duplicate."
- **Action:** FLAG (import).
- **Why:** Two $40 coffees on the same day by the same person is *plausible*. Skipping would silently lose real expenses; flagging delegates the judgment call to a human with context.
- **Alternatives:** skip (rejected: false positives destroy data); ignore (rejected: misses the most common real-world export bug).

### A13. `MEMBERSHIP_TIMING` — payer/participant not an active member on the expense date
- **Detection:** for each referenced user: `joined_at ≤ expense.date` and (`left_at` is null or `left_at ≥ expense.date`).
- **Message:** "Row 41: 'Sarah' left the group on 2024-03-01 but this expense is dated 2024-03-15 — row skipped."
- **Action:** REJECT.
- **Why:** This is the anomaly that proves the membership model works. Importing it would assign debt to someone who, per our own records, wasn't there — indefensible in an audit.
- **Alternatives:** FLAG and import (defensible if CSV is treated as more authoritative than app history; we treat the **app as the system of record** and the CSV as untrusted input — stated as a global principle in DECISIONS.md #7); auto-extend membership (rejected: import must not mutate membership).

### A14. `SPLIT_SUM_MISMATCH` — exact splits don't sum to total
- **Detection:** Σ(split amounts in cents) ≠ amount_cents.
- **Message:** "Row 22: splits total 95.00 but amount is 100.00 (off by 5.00) — row skipped."
- **Action:** REJECT.
- **Why:** The split-sum invariant is the core integrity guarantee of the whole system; the DB never accepts a violating expense from the UI either. Auto-scaling splits changes what each person owes without consent.
- **Alternatives:** distribute the diff proportionally (rejected: invents numbers); pad the payer (rejected: arbitrary winner/loser).

### A15. `PERCENT_SUM_MISMATCH` — percentages ≠ 100
- **Detection:** Σ(pct) ≠ 100 within ±0.01 tolerance (then computed shares use largest-remainder, so cents still sum exactly).
- **Message:** "Row 26: percentages total 90% — row skipped."
- **Action:** REJECT (tolerance band NORMALIZEs e.g. 33.33+33.33+33.34 inputs).
- **Why / Alternatives:** same reasoning as A14; the tolerance exists because 1/3 can't be written exactly in decimal — that's a representation artifact, not an intent ambiguity.

### A16. `INVALID_SPLIT_TYPE` — unknown value in split_type
- **Detection:** not in {EQUAL, EXACT, PERCENTAGE} after trim/uppercase.
- **Message:** "Row 11: split type 'shares' is not supported — row skipped."
- **Action:** REJECT (NORMALIZE obvious aliases: "equally" → EQUAL, noted in report).
- **Why:** Defaulting to EQUAL when the file said something else overrides explicit intent.
- **Alternatives:** default to EQUAL with FLAG (rejected: changes per-person amounts vs what the file's author intended).

### A17. `SELF_ONLY_EXPENSE` — payer is the sole participant
- **Detection:** participants == {payer}.
- **Message:** "Row 36: expense involves only the payer — imported and flagged (no effect on balances)."
- **Action:** FLAG (import).
- **Why:** Net effect is zero, so it can't corrupt balances; people do log personal spend in group trips for record-keeping. Harmless + plausible ⇒ keep with note.
- **Alternatives:** reject (rejected: destroys harmless data); silent import (report should still surface oddities).

### A18. `CURRENCY_MISMATCH` — currency column/symbol differs from group currency
- **Detection:** explicit currency column ≠ assumed currency, or non-default symbol prefix.
- **Message:** "Row 44: amount in EUR but this group tracks USD — row skipped (no conversion performed)."
- **Action:** REJECT.
- **Why:** Multi-currency is out of scope; converting at some arbitrary rate silently changes value. Reject-with-honesty beats fake support.
- **Alternatives:** convert at current rate (rejected: which rate? expense date? import date?); strip symbol and import number (rejected: 50 EUR ≠ 50 USD).

### A19. `WHITESPACE_AND_CASE` — `" John "` vs `"john"`, BOM, NBSP, CRLF
- **Detection:** normalization pass before any matching: strip BOM, trim, collapse internal whitespace, casefold for identity matching (originals preserved in `raw_data`).
- **Message:** none per-row (counted once: "12 rows required whitespace normalization").
- **Action:** NORMALIZE silently-with-count.
- **Why:** This is formatting noise, not intent ambiguity; refusing to handle it makes everything else (duplicate detection! user matching!) produce false anomalies.
- **Alternatives:** strict byte-exact matching (rejected: a trailing space would make "John " an UNKNOWN_USER — pure user hostility).

### A20. `EMPTY_ROW` / trailing blank lines
- **Detection:** all fields empty after trim.
- **Message:** counted once in summary.
- **Action:** skip silently-with-count (not REJECT — it isn't data).
- **Why:** Every spreadsheet export has them; they're not anomalies in the data, only in the file.

### A21. `SETTLEMENT_ANOMALIES` (if CSV carries settlements)
- Same pipeline: unknown user → REJECT; non-positive amount → REJECT; `from == to` → REJECT ("self-settlement has no meaning"); settlement exceeding current debt → **FLAG and import** (overpayment legitimately flips the direction of who owes whom — balances stay consistent because they're derived).

---

## 5. Global Import Principles (the part to say out loud in the interview)

1. **The app is the system of record; the CSV is untrusted input.** Conflicts resolve in the app's favor.
2. **Never silently alter money or identity.** Normalizations that don't touch either (whitespace, currency-symbol stripping) are fine; everything else is REJECT or FLAG.
3. **Partial import with a complete report** beats all-or-nothing: one bad row out of 500 shouldn't block 499 good ones, and the report makes the 1 fixable.
4. **Idempotent by construction** (row hashing vs all prior batches): uploading twice is safe.
5. **Every row is accounted for**: imported + flagged + rejected + duplicates + blank == total. The report ships the original raw line for each, so the user can fix-and-reupload only the rejects.
