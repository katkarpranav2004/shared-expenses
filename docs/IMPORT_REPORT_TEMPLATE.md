# Import Report (template)

> This is the shape the app produces (and persists) when it ingests
> `expenses_export.csv`. It is viewable in-app at
> `/groups/[id]/imports/[batchId]` and downloadable as CSV or JSON from
> `/api/groups/[id]/imports/[batchId]?format=csv|json`. Below is the expected
> outcome for the real file, used as the acceptance check for the import.

## Batch summary

| Field | Value |
|---|---|
| File | expenses_export.csv |
| Total data rows | 42 |
| Imported (clean) | _n_ |
| Imported + flagged | _n_ |
| Reclassified (→ settlement / refund) | _n_ |
| Rejected | _n_ |
| Duplicates skipped | _n_ |
| Empty | _n_ |
| Base currency | INR |
| USD→INR rate applied | 1 USD = ₹__.__ (snapshot YYYY-MM-DD) |

`imported + flagged + reclassified + rejected + duplicate + empty == total` (always).

## Per-row outcomes (the anomalies the file is built around)

| Row | Original line (abbrev.) | Outcome | Reason code(s) | Action taken |
|---|---|---|---|---|
| 4/5 | Marina Bites ×2, ₹3200 | DUPLICATE | `EXACT_DUPLICATE` | row 5 skipped |
| 6 | Electricity "1,200" | IMPORTED | `AMOUNT_THOUSANDS_SEP` | normalized → ₹1,200.00 |
| 9 | Cylinder refill 899.995 | REJECTED | `EXCESS_PRECISION` | skipped (no silent rounding) |
| 10 | paid_by "Priya S" | FLAGGED | `AMBIGUOUS_IDENTITY` | imported; closest match "Priya" surfaced |
| 11 | birthday cake `unequal` | IMPORTED | `UNEQUAL_ALIAS` | treated as EXACT (700/400/400 = 1500) |
| 12 | House cleaning, no payer | REJECTED | `MISSING_PAYER` | skipped |
| 13 | "Rohan paid Aisha back" | RECLASSIFIED | `SETTLEMENT_AS_EXPENSE` | recorded as settlement Rohan→Aisha ₹5,000 |
| 14 | Pizza % = 110 | REJECTED | `PERCENT_SUM_MISMATCH` | skipped |
| 19/20/22 | USD rows | IMPORTED | `FOREIGN_CURRENCY` | converted to INR at snapshot rate; original kept |
| 21/32 | `share` ratio splits | IMPORTED | `SHARE_SPLIT` | ratio split (1:2:1:2 / 2:1:1) |
| 22 | "Dev's friend Kabir" | REJECTED | `UNKNOWN_PARTICIPANT_GUEST` | skipped; hint "add Kabir then re-import" |
| 23/24 | Thalassa ₹2400 vs ₹2450 | FLAGGED ×2 | `CONFLICTING_DUPLICATE` | both imported, flagged for human resolution |
| 25 | Parasailing refund −30 USD | RECLASSIFIED | `NEGATIVE_AMOUNT` | refund (converted), flagged |
| 26 | "Mar-14", "rohan " | FLAGGED | `DATE_AMBIGUOUS`,`WHITESPACE_CASE` | date→2026-03-14, payer normalized |
| 27 | DMart, no currency | FLAGGED | `MISSING_CURRENCY` | defaulted to INR |
| 29 | Swiggy 0 | REJECTED | `ZERO_AMOUNT` | skipped |
| 33 | "04-05-2026" out of order | FLAGGED | `DATE_AMBIGUOUS` | parsed May 4; flagged |
| 35 | Meera in 02-04 groceries | FLAGGED | `MEMBERSHIP_TIMING` | Meera left 31-03; surfaced |
| 37–40 | Sam rows before mid-Apr join | FLAGGED | `MEMBERSHIP_TIMING` | surfaced per Sam's request |
| 39 | Furniture equal + details | FLAGGED | `SPLIT_TYPE_DETAIL_CONFLICT` | honored EQUAL; details ignored, noted |

(The full report lists all 42 rows, including the clean ones, each with its verbatim
original line.)
