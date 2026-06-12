// Shared server-side expense validation: the UI path and the edit path both
// run through here, and the CSV import path enforces the same rules in
// lib/import/validate.ts. Client-sent split values are PROPOSALS — shares are
// recomputed here from raw inputs (DECISIONS.md #4).

import { z } from "zod";
import { parseAmount, parsePercent } from "./money";
import { equalShares, percentShares, validateExactShares } from "./split";

export const expenseSchema = z.object({
  description: z.string().trim().min(1).max(200),
  amount: z.string().trim().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paidById: z.string().min(1),
  splitType: z.enum(["EQUAL", "EXACT", "PERCENTAGE"]),
  participantIds: z.array(z.string().min(1)).min(1).max(100),
  exact: z.record(z.string(), z.string()).optional(),
  percents: z.record(z.string(), z.string()).optional(),
});

export type ExpenseInput = z.infer<typeof expenseSchema>;

export type BuiltExpense = {
  description: string;
  amountCents: number;
  date: Date;
  paidById: string;
  splitType: "EQUAL" | "EXACT" | "PERCENTAGE";
  splits: { userId: string; shareCents: number }[];
};

export function buildExpense(
  input: ExpenseInput,
  activeMemberIds: Set<string>,
): { ok: true; expense: BuiltExpense } | { ok: false; code: string; message: string } {
  const err = (code: string, message: string) => ({ ok: false as const, code, message });

  if (!activeMemberIds.has(input.paidById)) {
    return err("UNKNOWN_USER", "The payer is not an active member of this group.");
  }
  const participantIds = [...new Set(input.participantIds)];
  if (participantIds.length !== input.participantIds.length) {
    return err("DUPLICATE_PARTICIPANT", "A participant is listed more than once.");
  }
  for (const id of participantIds) {
    if (!activeMemberIds.has(id)) {
      return err("UNKNOWN_USER", "A participant is not an active member of this group.");
    }
  }

  const amount = parseAmount(input.amount);
  if (!amount.ok) {
    const messages: Record<string, string> = {
      INVALID_AMOUNT: "Enter a valid amount, e.g. 45.50.",
      EXCESS_PRECISION: "Amounts can have at most 2 decimal places.",
      NEGATIVE_AMOUNT: "Amount must be positive.",
      ZERO_AMOUNT: "Amount must be greater than zero.",
      CURRENCY_MISMATCH: "Only USD amounts are supported.",
    };
    return err(amount.code, messages[amount.code]);
  }

  // Strict date — same rule as import (A7): no JS date rolling.
  const [y, m, d] = input.date.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.toISOString().slice(0, 10) !== input.date) {
    return err("INVALID_DATE", "That date does not exist.");
  }

  // Deterministic order: sort by user id before allocating remainder cents.
  const sorted = [...participantIds].sort();
  let splits: { userId: string; shareCents: number }[];

  if (input.splitType === "EQUAL") {
    const shares = equalShares(amount.cents, sorted.length);
    splits = sorted.map((userId, i) => ({ userId, shareCents: shares[i] }));
  } else if (input.splitType === "EXACT") {
    const shares: number[] = [];
    for (const userId of sorted) {
      const raw = input.exact?.[userId];
      if (raw === undefined) return err("SPLIT_SUM_MISMATCH", "Every participant needs an exact amount.");
      const p = parseAmount(raw);
      // ZERO is allowed inside an exact split (someone shared nothing of this
      // item) even though a zero TOTAL is not — hence the special case.
      if (!p.ok && p.code === "ZERO_AMOUNT") shares.push(0);
      else if (!p.ok) return err("SPLIT_SUM_MISMATCH", "One of the exact amounts is invalid.");
      else shares.push(p.cents);
    }
    if (!validateExactShares(amount.cents, shares)) {
      return err("SPLIT_SUM_MISMATCH", "The exact amounts must add up to the total.");
    }
    splits = sorted.map((userId, i) => ({ userId, shareCents: shares[i] }));
  } else {
    const bps: number[] = [];
    for (const userId of sorted) {
      const raw = input.percents?.[userId];
      if (raw === undefined) return err("PERCENT_SUM_MISMATCH", "Every participant needs a percentage.");
      const p = parsePercent(raw);
      if (!p.ok) return err("PERCENT_SUM_MISMATCH", "One of the percentages is invalid.");
      bps.push(p.bp);
    }
    const total = bps.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 10000) > 1) {
      return err("PERCENT_SUM_MISMATCH", `Percentages add up to ${(total / 100).toFixed(2)}%, not 100%.`);
    }
    const shares = percentShares(amount.cents, bps);
    splits = sorted.map((userId, i) => ({ userId, shareCents: shares[i] }));
  }

  return {
    ok: true,
    expense: {
      description: input.description,
      amountCents: amount.cents,
      date,
      paidById: input.paidById,
      splitType: input.splitType,
      splits,
    },
  };
}
