// Anomaly codes — shared language between SCOPE.md, the API error shape,
// the import report, and the tests. One code per anomaly class.

export const ANOMALY = {
  MALFORMED_ROW: "MALFORMED_ROW", // A1
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD", // A2
  INVALID_AMOUNT: "INVALID_AMOUNT", // A3
  AMOUNT_NORMALIZED: "AMOUNT_NORMALIZED", // A3 (normalize note)
  EXCESS_PRECISION: "EXCESS_PRECISION", // A4
  NEGATIVE_AMOUNT: "NEGATIVE_AMOUNT", // A5
  ZERO_AMOUNT: "ZERO_AMOUNT", // A6
  INVALID_DATE: "INVALID_DATE", // A7
  FUTURE_DATE: "FUTURE_DATE", // A8 (flag)
  UNKNOWN_USER: "UNKNOWN_USER", // A9
  DUPLICATE_ROW: "DUPLICATE_ROW", // A11
  NEAR_DUPLICATE: "NEAR_DUPLICATE", // A12 (flag)
  MEMBERSHIP_TIMING: "MEMBERSHIP_TIMING", // A13
  SPLIT_SUM_MISMATCH: "SPLIT_SUM_MISMATCH", // A14
  PERCENT_SUM_MISMATCH: "PERCENT_SUM_MISMATCH", // A15
  INVALID_SPLIT_TYPE: "INVALID_SPLIT_TYPE", // A16
  SPLIT_TYPE_NORMALIZED: "SPLIT_TYPE_NORMALIZED", // A16 (alias note)
  SELF_ONLY_EXPENSE: "SELF_ONLY_EXPENSE", // A17 (flag)
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH", // A18
  DUPLICATE_PARTICIPANT: "DUPLICATE_PARTICIPANT", // participant listed twice
} as const;

export type AnomalyCode = (typeof ANOMALY)[keyof typeof ANOMALY];

export type RowOutcome = "IMPORTED" | "FLAGGED" | "REJECTED" | "DUPLICATE" | "EMPTY";

export type MemberCtx = {
  userId: string;
  name: string;
  email: string;
  joinedAt: Date;
  leftAt: Date | null;
};

export type ValidationCtx = {
  members: MemberCtx[];
  // sha256 hashes of rows already imported in prior batches (idempotency, A11)
  existingHashes: Set<string>;
  // "date|payerId|amountCents" keys of existing expenses (near-duplicates, A12)
  existingNearKeys: Set<string>;
  today: Date;
};

export type ParsedExpense = {
  date: string; // ISO yyyy-mm-dd
  description: string;
  amountCents: number;
  paidById: string;
  splitType: "EQUAL" | "EXACT" | "PERCENTAGE";
  splits: { userId: string; shareCents: number }[];
};

export type RowResult = {
  rowNumber: number; // 1-based data row (header excluded)
  raw: string;
  hash: string;
  outcome: RowOutcome;
  reasons: AnomalyCode[];
  messages: string[]; // human-readable, one per reason
  expense?: ParsedExpense; // present iff outcome is IMPORTED or FLAGGED
};

export type ValidationResult = {
  ok: boolean; // header was usable
  fileError?: string;
  rows: RowResult[];
  summary: {
    total: number;
    imported: number;
    flagged: number;
    rejected: number;
    duplicate: number;
    empty: number;
    normalizedWhitespace: number;
  };
};

export const EXPECTED_HEADER = [
  "date",
  "description",
  "amount",
  "paid_by",
  "split_type",
  "participants",
  "splits",
] as const;
