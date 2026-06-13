// Anomaly codes — shared language between SCOPE.md, the API error shape,
// the import report, and the tests. One code per anomaly class in the real CSV.

export const ANOMALY = {
  // structural
  MALFORMED_ROW: "MALFORMED_ROW",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  EMPTY_ROW: "EMPTY_ROW",
  // dates
  DATE_AMBIGUOUS: "DATE_AMBIGUOUS", // flag (Mar-14 inferred year, 04-05 out of sequence)
  INVALID_DATE: "INVALID_DATE", // reject
  // amounts
  AMOUNT_NORMALIZED: "AMOUNT_NORMALIZED", // note (thousands separator)
  EXCESS_PRECISION: "EXCESS_PRECISION", // reject (899.995)
  ZERO_AMOUNT: "ZERO_AMOUNT", // reject
  NEGATIVE_AMOUNT: "NEGATIVE_AMOUNT", // reclassify → refund (flag)
  INVALID_AMOUNT: "INVALID_AMOUNT", // reject
  // currency
  MISSING_CURRENCY: "MISSING_CURRENCY", // normalize → base, flag
  FOREIGN_CURRENCY: "FOREIGN_CURRENCY", // converted to base, note
  UNSUPPORTED_CURRENCY: "UNSUPPORTED_CURRENCY", // reject (no rate)
  // identity
  UNKNOWN_USER: "UNKNOWN_USER", // reject (Kabir)
  AMBIGUOUS_IDENTITY: "AMBIGUOUS_IDENTITY", // flag, attribute to closest (Priya S)
  WHITESPACE_CASE: "WHITESPACE_CASE", // normalize (count)
  DUPLICATE_PARTICIPANT: "DUPLICATE_PARTICIPANT", // reject
  MEMBERSHIP_TIMING: "MEMBERSHIP_TIMING", // flag (Meera after move-out)
  // splits
  SPLIT_TYPE_NORMALIZED: "SPLIT_TYPE_NORMALIZED", // note (unequal → EXACT)
  INVALID_SPLIT_TYPE: "INVALID_SPLIT_TYPE", // reject
  SPLIT_SUM_MISMATCH: "SPLIT_SUM_MISMATCH", // reject (exact/share details bad)
  PERCENT_SUM_MISMATCH: "PERCENT_SUM_MISMATCH", // reject (110%)
  SPLIT_TYPE_DETAIL_CONFLICT: "SPLIT_TYPE_DETAIL_CONFLICT", // flag (equal + details)
  SELF_ONLY_EXPENSE: "SELF_ONLY_EXPENSE", // flag (net-zero)
  ONE_SIDED_EXPENSE: "ONE_SIDED_EXPENSE", // flag (payer covers a single other — possible transfer)
  // duplicates / settlements
  DUPLICATE_ROW: "DUPLICATE_ROW", // skip (Marina: same date/payer/amount)
  CONFLICTING_DUPLICATE: "CONFLICTING_DUPLICATE", // flag both (Thalassa)
  SETTLEMENT_AS_EXPENSE: "SETTLEMENT_AS_EXPENSE", // reclassify → settlement
} as const;

export type AnomalyCode = (typeof ANOMALY)[keyof typeof ANOMALY];

export type RowOutcome =
  | "IMPORTED"
  | "FLAGGED"
  | "REJECTED"
  | "DUPLICATE"
  | "RECLASSIFIED"
  | "EMPTY";

export type MemberCtx = {
  userId: string;
  name: string;
  email: string;
  joinedAt: Date;
  leftAt: Date | null;
};

export type ValidationCtx = {
  members: MemberCtx[];
  baseCurrency: string; // group base currency (INR)
  existingHashes: Set<string>; // idempotency vs prior batches
  today: Date;
};

export type SplitType = "EQUAL" | "EXACT" | "PERCENTAGE" | "SHARE";

export type ParsedExpense = {
  date: string; // ISO yyyy-mm-dd (base)
  description: string;
  currency: string; // original currency as written
  originalAmountCents: number; // amount in original currency minor units
  amountCents: number; // BASE (INR paise) — what balance math uses
  fxRateBp: number; // rate applied (INR per unit × 100)
  paidById: string;
  splitType: SplitType;
  splits: { userId: string; shareCents: number }[]; // BASE minor units
  notes?: string;
  isRefund?: boolean; // negative source amount, modelled as a reversing expense
};

export type ParsedSettlement = {
  date: string;
  fromUserId: string;
  toUserId: string;
  currency: string;
  originalAmountCents: number;
  amountCents: number; // BASE
  fxRateBp: number;
  note?: string;
};

export type RowResult = {
  rowNumber: number; // 1-based data row (header excluded)
  raw: string;
  hash: string;
  outcome: RowOutcome;
  reasons: AnomalyCode[];
  messages: string[];
  expense?: ParsedExpense; // present for IMPORTED / FLAGGED expense rows
  settlement?: ParsedSettlement; // present for RECLASSIFIED settlement rows
};

export type ValidationResult = {
  ok: boolean;
  fileError?: string;
  rows: RowResult[];
  summary: {
    total: number;
    imported: number;
    flagged: number;
    rejected: number;
    duplicate: number;
    reclassified: number;
    empty: number;
    normalizedWhitespace: number;
    convertedCurrency: number;
  };
};

// Real expenses_export.csv header. Required columns are matched by name,
// order-independent; `split_details` and `notes` are optional.
export const EXPECTED_HEADER = [
  "date",
  "description",
  "paid_by",
  "amount",
  "currency",
  "split_type",
  "split_with",
  "split_details",
  "notes",
] as const;

export const REQUIRED_HEADER = ["date", "paid_by", "amount", "split_with"] as const;
