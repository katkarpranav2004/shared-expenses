// CSV anomaly detection. Pure function: (csv text, context) -> per-row verdicts.
// No database, no framework — the policy in SCOPE.md §4, executable.
//
// Global principles (SCOPE.md §5):
//   1. The app is the system of record; the CSV is untrusted input.
//   2. Never silently alter money or identity.
//   3. Partial import with a complete report.
//   4. Idempotent by construction.
//   5. Every row is accounted for.

import { createHash } from "node:crypto";
import { parseAmount, parsePercent, formatCents } from "../money";
import { equalShares, percentShares } from "../split";
import { parseCsv } from "./parseCsv";
import {
  ANOMALY,
  EXPECTED_HEADER,
  type AnomalyCode,
  type MemberCtx,
  type ParsedExpense,
  type RowResult,
  type ValidationCtx,
  type ValidationResult,
} from "./types";

// ---------- helpers ----------

// A19: formatting noise is normalized before any matching; originals are
// preserved in raw_data. NBSP and zero-width chars included.
function norm(s: string): string {
  return s.replace(/[ ​‌‍﻿]/g, " ").replace(/\s+/g, " ").trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3; // we only care about distance <= 2
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

function matchMember(token: string, members: MemberCtx[]): MemberCtx | null {
  const t = norm(token).toLowerCase();
  if (t === "") return null;
  return (
    members.find((m) => m.email.toLowerCase() === t) ??
    members.find((m) => norm(m.name).toLowerCase() === t) ??
    null
  );
}

function closestMember(token: string, members: MemberCtx[]): MemberCtx | null {
  const t = norm(token).toLowerCase();
  let best: MemberCtx | null = null;
  let bestD = 3;
  for (const m of members) {
    const d = Math.min(
      levenshtein(t, m.name.toLowerCase()),
      levenshtein(t, m.email.toLowerCase()),
    );
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return bestD <= 2 ? best : null;
}

// A7: strict ISO date. Re-serialize and compare so JS Date can't silently
// roll 2024-02-30 into 2024-03-01.
function parseDateStrict(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(norm(s));
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  const roundTrip = date.toISOString().slice(0, 10);
  return roundTrip === `${y}-${mo}-${d}` ? date : null;
}

const SPLIT_TYPE_ALIASES: Record<string, "EQUAL" | "EXACT" | "PERCENTAGE"> = {
  EQUAL: "EQUAL",
  EQUALLY: "EQUAL",
  EXACT: "EXACT",
  AMOUNT: "EXACT",
  AMOUNTS: "EXACT",
  PERCENTAGE: "PERCENTAGE",
  PERCENT: "PERCENTAGE",
  PCT: "PERCENTAGE",
};

// A11: idempotency hash over the normalized semantic content of the row.
export function rowHash(fields: {
  date: string;
  description: string;
  amountCents: number;
  payerKey: string;
  splitType: string;
  participantKeys: string[];
  splitSpec: string;
}): string {
  const canonical = [
    fields.date,
    norm(fields.description).toLowerCase(),
    String(fields.amountCents),
    fields.payerKey,
    fields.splitType,
    [...fields.participantKeys].sort().join(";"),
    norm(fields.splitSpec).toLowerCase(),
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

// Fallback hash for rows we couldn't parse (still needed for the report).
function rawHash(raw: string): string {
  return createHash("sha256").update(norm(raw).toLowerCase()).digest("hex");
}

// ---------- main ----------

export function validateCsv(text: string, ctx: ValidationCtx): ValidationResult {
  const empty = (): ValidationResult["summary"] => ({
    total: 0,
    imported: 0,
    flagged: 0,
    rejected: 0,
    duplicate: 0,
    empty: 0,
    normalizedWhitespace: 0,
  });

  const records = parseCsv(text);
  if (records.length === 0) {
    return { ok: false, fileError: "File is empty.", rows: [], summary: empty() };
  }

  // Header: required columns by name, order-independent (column shuffling is
  // a file variation, not an anomaly worth rejecting a file over).
  const headerFields = records[0].fields.map((f) => norm(f).toLowerCase());
  const colIndex = new Map<string, number>();
  for (const col of EXPECTED_HEADER) {
    const idx = headerFields.indexOf(col);
    if (idx >= 0) colIndex.set(col, idx);
  }
  const missingCols = EXPECTED_HEADER.filter(
    (c) => c !== "splits" && !colIndex.has(c),
  );
  if (missingCols.length > 0) {
    return {
      ok: false,
      fileError: `Header is missing required column(s): ${missingCols.join(", ")}. Expected: ${EXPECTED_HEADER.join(", ")}`,
      rows: [],
      summary: empty(),
    };
  }
  const expectedWidth = records[0].fields.length;

  const summary = empty();
  const rows: RowResult[] = [];
  const seenHashes = new Set<string>(); // within-file duplicates
  const seenNearKeys = new Set<string>(); // within-file near-duplicates
  const todayIso = ctx.today.toISOString().slice(0, 10);

  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    const rowNumber = r; // 1-based data row, header excluded
    summary.total++;

    const reasons: AnomalyCode[] = [];
    const messages: string[] = [];
    const reject = (code: AnomalyCode, msg: string) => {
      reasons.push(code);
      messages.push(msg);
    };

    // A20: empty row — counted, not persisted.
    if (rec.fields.every((f) => norm(f) === "")) {
      summary.empty++;
      rows.push({
        rowNumber,
        raw: rec.raw,
        hash: rawHash(rec.raw || `empty-${rowNumber}`),
        outcome: "EMPTY",
        reasons: [],
        messages: [],
      });
      continue;
    }

    // A1: malformed row (field count mismatch).
    if (rec.fields.length !== expectedWidth) {
      rows.push({
        rowNumber,
        raw: rec.raw,
        hash: rawHash(rec.raw),
        outcome: "REJECTED",
        reasons: [ANOMALY.MALFORMED_ROW],
        messages: [
          `Expected ${expectedWidth} columns, found ${rec.fields.length} — row skipped.`,
        ],
      });
      summary.rejected++;
      continue;
    }

    const get = (col: (typeof EXPECTED_HEADER)[number]) => {
      const idx = colIndex.get(col);
      return idx === undefined ? "" : rec.fields[idx] ?? "";
    };
    const rawDate = get("date");
    const rawDesc = get("description");
    const rawAmount = get("amount");
    const rawPayer = get("paid_by");
    const rawSplitType = get("split_type");
    const rawParticipants = get("participants");
    const rawSplits = get("splits");

    if ([rawDate, rawDesc, rawAmount, rawPayer, rawParticipants].some((f) => f !== norm(f))) {
      summary.normalizedWhitespace++; // A19, counted once per row
    }

    // A2: missing required fields.
    const required: [string, string][] = [
      ["date", rawDate],
      ["amount", rawAmount],
      ["paid_by", rawPayer],
      ["participants", rawParticipants],
    ];
    const missing = required.filter(([, v]) => norm(v) === "").map(([k]) => k);
    if (missing.length > 0) {
      reject(
        ANOMALY.MISSING_REQUIRED_FIELD,
        `Missing required field(s): ${missing.join(", ")} — row skipped.`,
      );
    }

    // A3-A6, A18: amount.
    let amountCents = 0;
    if (norm(rawAmount) !== "") {
      const parsed = parseAmount(rawAmount);
      if (parsed.ok) {
        amountCents = parsed.cents;
        if (parsed.normalized) {
          reasons.push(ANOMALY.AMOUNT_NORMALIZED);
          messages.push(
            `Amount '${norm(rawAmount)}' normalized to ${formatCents(parsed.cents)}.`,
          );
        }
      } else {
        const msg: Record<string, string> = {
          INVALID_AMOUNT: `Amount '${norm(rawAmount)}' is not a valid amount — row skipped.`,
          EXCESS_PRECISION: `Amount '${norm(rawAmount)}' has sub-cent precision — row skipped (amounts are never rounded silently).`,
          NEGATIVE_AMOUNT: `Negative amount '${norm(rawAmount)}' — row skipped. If this is a refund, record it as a settlement or an expense paid by the other party.`,
          ZERO_AMOUNT: `Amount is zero — row skipped (no financial effect).`,
          CURRENCY_MISMATCH: `Amount '${norm(rawAmount)}' appears to be a non-USD currency — row skipped (no conversion performed).`,
        };
        reject(parsed.code as AnomalyCode, msg[parsed.code]);
      }
    }

    // A7/A8: date.
    let dateIso = "";
    let date: Date | null = null;
    if (norm(rawDate) !== "") {
      date = parseDateStrict(rawDate);
      if (!date) {
        reject(
          ANOMALY.INVALID_DATE,
          `Date '${norm(rawDate)}' is not a valid YYYY-MM-DD date — row skipped.`,
        );
      } else {
        dateIso = date.toISOString().slice(0, 10);
        if (dateIso > todayIso) {
          reasons.push(ANOMALY.FUTURE_DATE);
          messages.push(`Date ${dateIso} is in the future — imported and flagged.`);
        }
      }
    }

    // A16: split type.
    let splitType: "EQUAL" | "EXACT" | "PERCENTAGE" | null = null;
    const stRaw = norm(rawSplitType).toUpperCase();
    if (stRaw === "") {
      splitType = "EQUAL"; // absent column value defaults to equal — noted
    } else if (SPLIT_TYPE_ALIASES[stRaw]) {
      splitType = SPLIT_TYPE_ALIASES[stRaw];
      if (stRaw !== splitType) {
        reasons.push(ANOMALY.SPLIT_TYPE_NORMALIZED);
        messages.push(`Split type '${norm(rawSplitType)}' interpreted as ${splitType}.`);
      }
    } else {
      reject(
        ANOMALY.INVALID_SPLIT_TYPE,
        `Split type '${norm(rawSplitType)}' is not supported (EQUAL, EXACT, PERCENTAGE) — row skipped.`,
      );
    }

    // A9: payer and participants must match known members.
    const payer = matchMember(rawPayer, ctx.members);
    if (norm(rawPayer) !== "" && !payer) {
      const hint = closestMember(rawPayer, ctx.members);
      reject(
        ANOMALY.UNKNOWN_USER,
        `Payer '${norm(rawPayer)}' does not match any member of this group — row skipped.` +
          (hint ? ` Closest match: '${hint.name}'.` : ""),
      );
    }

    const participantTokens = norm(rawParticipants) === ""
      ? []
      : rawParticipants.split(";").map((t) => norm(t)).filter((t) => t !== "");
    const participants: MemberCtx[] = [];
    const seenIds = new Set<string>();
    for (const token of participantTokens) {
      const m = matchMember(token, ctx.members);
      if (!m) {
        const hint = closestMember(token, ctx.members);
        reject(
          ANOMALY.UNKNOWN_USER,
          `Participant '${token}' does not match any member of this group — row skipped.` +
            (hint ? ` Closest match: '${hint.name}'.` : ""),
        );
      } else if (seenIds.has(m.userId)) {
        reject(
          ANOMALY.DUPLICATE_PARTICIPANT,
          `Participant '${token}' is listed more than once — row skipped.`,
        );
      } else {
        seenIds.add(m.userId);
        participants.push(m);
      }
    }

    // A13: membership timing — everyone referenced must have been an active
    // member ON the expense date (joined_at <= date <= left_at).
    if (date) {
      const everyone = payer ? [payer, ...participants] : participants;
      for (const m of everyone) {
        const joined = m.joinedAt.toISOString().slice(0, 10);
        const left = m.leftAt ? m.leftAt.toISOString().slice(0, 10) : null;
        if (joined > dateIso) {
          reject(
            ANOMALY.MEMBERSHIP_TIMING,
            `'${m.name}' joined the group on ${joined}, after this expense's date ${dateIso} — row skipped.`,
          );
        } else if (left && left < dateIso) {
          reject(
            ANOMALY.MEMBERSHIP_TIMING,
            `'${m.name}' left the group on ${left}, before this expense's date ${dateIso} — row skipped.`,
          );
        }
      }
    }

    // Splits (A14/A15) — only computable if everything above held.
    const fatal = reasons.some(
      (c) =>
        c !== ANOMALY.AMOUNT_NORMALIZED &&
        c !== ANOMALY.SPLIT_TYPE_NORMALIZED &&
        c !== ANOMALY.FUTURE_DATE,
    );

    let splits: { userId: string; shareCents: number }[] = [];
    if (!fatal && splitType && participants.length > 0 && amountCents > 0) {
      const sorted = [...participants].sort((a, b) => a.userId.localeCompare(b.userId));
      if (splitType === "EQUAL") {
        const shares = equalShares(amountCents, sorted.length);
        splits = sorted.map((m, i) => ({ userId: m.userId, shareCents: shares[i] }));
      } else {
        // splits column: "Name=12.50;Name=7.50" (EXACT) or "Name=60;Name=40" (PERCENTAGE)
        const specs = rawSplits.split(";").map((t) => norm(t)).filter((t) => t !== "");
        const byUser = new Map<string, string>();
        let specError = false;
        for (const spec of specs) {
          const eq = spec.indexOf("=");
          if (eq < 0) {
            reject(
              splitType === "EXACT" ? ANOMALY.SPLIT_SUM_MISMATCH : ANOMALY.PERCENT_SUM_MISMATCH,
              `Split entry '${spec}' is not in 'Name=value' form — row skipped.`,
            );
            specError = true;
            break;
          }
          const m = matchMember(spec.slice(0, eq), ctx.members);
          if (!m || !seenIds.has(m.userId)) {
            reject(
              ANOMALY.UNKNOWN_USER,
              `Split entry '${spec}' names someone who is not in this row's participants — row skipped.`,
            );
            specError = true;
            break;
          }
          byUser.set(m.userId, spec.slice(eq + 1));
        }

        if (!specError && byUser.size !== sorted.length) {
          reject(
            splitType === "EXACT" ? ANOMALY.SPLIT_SUM_MISMATCH : ANOMALY.PERCENT_SUM_MISMATCH,
            `Split column covers ${byUser.size} of ${sorted.length} participants — row skipped.`,
          );
          specError = true;
        }

        if (!specError && splitType === "EXACT") {
          const shares: number[] = [];
          for (const m of sorted) {
            const p = parseAmount(byUser.get(m.userId)!);
            // A zero share inside an exact split is legitimate (the person
            // shared nothing of this item) — same rule as the UI path.
            if (!p.ok && p.code === "ZERO_AMOUNT") {
              shares.push(0);
              continue;
            }
            if (!p.ok) {
              reject(
                ANOMALY.SPLIT_SUM_MISMATCH,
                `Split amount for '${m.name}' is invalid — row skipped.`,
              );
              specError = true;
              break;
            }
            shares.push(p.cents);
          }
          if (!specError) {
            const sum = shares.reduce((a, b) => a + b, 0);
            if (sum !== amountCents) {
              reject(
                ANOMALY.SPLIT_SUM_MISMATCH,
                `Splits total ${formatCents(sum)} but amount is ${formatCents(amountCents)} (off by ${formatCents(Math.abs(sum - amountCents))}) — row skipped.`,
              );
            } else {
              splits = sorted.map((m, i) => ({ userId: m.userId, shareCents: shares[i] }));
            }
          }
        }

        if (!specError && splitType === "PERCENTAGE") {
          const bps: number[] = [];
          for (const m of sorted) {
            const p = parsePercent(byUser.get(m.userId)!);
            if (!p.ok) {
              reject(
                ANOMALY.PERCENT_SUM_MISMATCH,
                `Percentage for '${m.name}' is invalid — row skipped.`,
              );
              specError = true;
              break;
            }
            bps.push(p.bp);
          }
          if (!specError) {
            const totalBp = bps.reduce((a, b) => a + b, 0);
            if (Math.abs(totalBp - 10000) > 1) {
              reject(
                ANOMALY.PERCENT_SUM_MISMATCH,
                `Percentages total ${(totalBp / 100).toFixed(2)}% — row skipped.`,
              );
            } else {
              const shares = percentShares(amountCents, bps);
              splits = sorted.map((m, i) => ({ userId: m.userId, shareCents: shares[i] }));
            }
          }
        }
      }
    }

    // A17: payer is the sole participant — net-zero, import + flag.
    if (
      payer &&
      participants.length === 1 &&
      participants[0].userId === payer.userId
    ) {
      reasons.push(ANOMALY.SELF_ONLY_EXPENSE);
      messages.push(
        "Expense involves only the payer — imported and flagged (no effect on balances).",
      );
    }

    const stillFatal = reasons.some(
      (c) =>
        c !== ANOMALY.AMOUNT_NORMALIZED &&
        c !== ANOMALY.SPLIT_TYPE_NORMALIZED &&
        c !== ANOMALY.FUTURE_DATE &&
        c !== ANOMALY.NEAR_DUPLICATE &&
        c !== ANOMALY.SELF_ONLY_EXPENSE,
    );

    if (stillFatal) {
      rows.push({
        rowNumber,
        raw: rec.raw,
        hash: rawHash(rec.raw),
        outcome: "REJECTED",
        reasons,
        messages,
      });
      summary.rejected++;
      continue;
    }

    // A11: duplicate detection over the semantic hash — within this file and
    // against every previously imported batch.
    const hash = rowHash({
      date: dateIso,
      description: rawDesc,
      amountCents,
      payerKey: payer!.userId,
      splitType: splitType!,
      participantKeys: participants.map((p) => p.userId),
      splitSpec: splitType === "EQUAL" ? "" : rawSplits,
    });
    if (seenHashes.has(hash)) {
      rows.push({
        rowNumber,
        raw: rec.raw,
        hash,
        outcome: "DUPLICATE",
        reasons: [ANOMALY.DUPLICATE_ROW],
        messages: ["Identical to an earlier row in this file — skipped."],
      });
      summary.duplicate++;
      continue;
    }
    if (ctx.existingHashes.has(hash)) {
      rows.push({
        rowNumber,
        raw: rec.raw,
        hash,
        outcome: "DUPLICATE",
        reasons: [ANOMALY.DUPLICATE_ROW],
        messages: ["Already imported in a previous batch — skipped."],
      });
      summary.duplicate++;
      continue;
    }
    seenHashes.add(hash);

    // A12: near-duplicate (same payer + amount + date, different description).
    const nearKey = `${dateIso}|${payer!.userId}|${amountCents}`;
    if (seenNearKeys.has(nearKey) || ctx.existingNearKeys.has(nearKey)) {
      reasons.push(ANOMALY.NEAR_DUPLICATE);
      messages.push(
        "Same payer, amount and date as another expense — imported and flagged as a possible duplicate.",
      );
    }
    seenNearKeys.add(nearKey);

    const flagged = reasons.some(
      (c) =>
        c === ANOMALY.FUTURE_DATE ||
        c === ANOMALY.NEAR_DUPLICATE ||
        c === ANOMALY.SELF_ONLY_EXPENSE,
    );

    const expense: ParsedExpense = {
      date: dateIso,
      description: norm(rawDesc) || "(no description)",
      amountCents,
      paidById: payer!.userId,
      splitType: splitType!,
      splits,
    };

    rows.push({
      rowNumber,
      raw: rec.raw,
      hash,
      outcome: flagged ? "FLAGGED" : "IMPORTED",
      reasons,
      messages,
      expense,
    });
    if (flagged) summary.flagged++;
    else summary.imported++;
  }

  return { ok: true, rows, summary };
}
