// CSV anomaly detection for the real expenses_export.csv. Pure function:
// (csv text, context) -> per-row verdicts. No database, no framework — the
// policy in SCOPE.md §5, executable.
//
// Global principles (SCOPE.md §6):
//   1. The app is the system of record; the CSV is untrusted input.
//   2. Never silently alter money or identity.
//   3. Convert currency, don't pretend.
//   4. Approval, not deletion: conflicts/duplicates are surfaced, not auto-edited.
//   5. Partial import + complete report; idempotent by row hash.

import { createHash } from "node:crypto";
import { parseAmount, parsePercent } from "../money";
import { equalShares, weightedShares } from "../split";
import { convertToBase, formatMoney, isSupportedCurrency } from "../currency";
import { parseCsv } from "./parseCsv";
import {
  ANOMALY,
  EXPECTED_HEADER,
  REQUIRED_HEADER,
  type AnomalyCode,
  type MemberCtx,
  type ParsedExpense,
  type ParsedSettlement,
  type RowResult,
  type SplitType,
  type ValidationCtx,
  type ValidationResult,
} from "./types";

// ---------- text + identity helpers ----------

function norm(s: string): string {
  return s.replace(/[ ​‌‍﻿]/g, " ").replace(/\s+/g, " ").trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
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

type MemberMatch =
  | { kind: "exact"; member: MemberCtx }
  | { kind: "ambiguous"; member: MemberCtx } // closest within edit distance 2
  | { kind: "none"; hint: MemberCtx | null };

function resolveMember(token: string, members: MemberCtx[]): MemberMatch {
  const t = norm(token).toLowerCase();
  if (t === "") return { kind: "none", hint: null };
  const exact =
    members.find((m) => m.email.toLowerCase() === t) ??
    members.find((m) => norm(m.name).toLowerCase() === t);
  if (exact) return { kind: "exact", member: exact };

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
  if (best && bestD <= 2) return { kind: "ambiguous", member: best };
  return { kind: "none", hint: best };
}

// ---------- date helpers ----------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isoFrom(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Round-trip: JS Date must not have rolled an impossible date (e.g. Feb 30).
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

// File convention is DD-MM-YYYY. Also accepts "Mon-DD" (year inferred).
function parseDate(
  raw: string,
  fileYear: number,
): { iso: string; ambiguous?: string } | null {
  const s = norm(raw);
  let m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) {
    const iso = isoFrom(+m[3], +m[2], +m[1]); // DD-MM-YYYY
    return iso ? { iso } : null;
  }
  m = /^([A-Za-z]{3})-(\d{1,2})$/.exec(s); // "Mar-14" — no year
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (!mo) return null;
    const iso = isoFrom(fileYear, mo, +m[2]);
    return iso ? { iso, ambiguous: `year inferred as ${fileYear}` } : null;
  }
  return null;
}

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

// ---------- split-detail parsing ----------

const SPLIT_TYPE_ALIASES: Record<string, SplitType> = {
  EQUAL: "EQUAL", EQUALLY: "EQUAL",
  EXACT: "EXACT", UNEQUAL: "EXACT", AMOUNT: "EXACT", AMOUNTS: "EXACT",
  PERCENTAGE: "PERCENTAGE", PERCENT: "PERCENTAGE", PCT: "PERCENTAGE",
  SHARE: "SHARE", SHARES: "SHARE", RATIO: "SHARE",
};

// "Rohan 700; Priya 400" or "Aisha 30%" or "Aisha=10.00" -> [{name, value}]
function parseSplitDetails(raw: string): { name: string; value: string }[] {
  return norm(raw)
    .split(";")
    .map((e) => norm(e))
    .filter((e) => e !== "")
    .map((e) => {
      const m = /^(.+?)[\s=]+([\d.]+)\s*%?$/.exec(e);
      return m ? { name: m[1], value: m[2] } : { name: e, value: "" };
    });
}

// ---------- hashing ----------

// Idempotency / duplicate hash over the semantic content EXCLUDING description
// (Marina Bites is logged twice with cosmetically different descriptions and is
// the same expense). Same (date, payer, base amount, participants, split) = dup.
function contentHash(f: {
  date: string;
  payerKey: string;
  amountCents: number;
  currency: string;
  participantKeys: string[];
  splitType: string;
  splitSpec: string;
}): string {
  const canonical = [
    f.date, f.payerKey, String(f.amountCents), f.currency,
    [...f.participantKeys].sort().join(";"), f.splitType, norm(f.splitSpec).toLowerCase(),
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

function rawHash(raw: string): string {
  return createHash("sha256").update(norm(raw).toLowerCase()).digest("hex");
}

const STOPWORDS = new Set(["at", "the", "a", "for", "of", "to", "-", "on", "in"]);
function descSignature(desc: string): string {
  return norm(desc)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .sort()
    .join(" ");
}

// ---------- main ----------

export function validateCsv(text: string, ctx: ValidationCtx): ValidationResult {
  const base = ctx.baseCurrency.toUpperCase();
  const summary = {
    total: 0, imported: 0, flagged: 0, rejected: 0, duplicate: 0,
    reclassified: 0, empty: 0, normalizedWhitespace: 0, convertedCurrency: 0,
  };

  const records = parseCsv(text);
  if (records.length === 0) {
    return { ok: false, fileError: "File is empty.", rows: [], summary };
  }

  const headerFields = records[0].fields.map((f) => norm(f).toLowerCase());
  const colIndex = new Map<string, number>();
  for (const col of EXPECTED_HEADER) {
    const idx = headerFields.indexOf(col);
    if (idx >= 0) colIndex.set(col, idx);
  }
  const missingCols = REQUIRED_HEADER.filter((c) => !colIndex.has(c));
  if (missingCols.length > 0) {
    return {
      ok: false,
      fileError: `Header is missing required column(s): ${missingCols.join(", ")}. Expected: ${EXPECTED_HEADER.join(", ")}`,
      rows: [],
      summary,
    };
  }
  const expectedWidth = records[0].fields.length;

  // Pre-scan: infer the file's year (for "Mon-DD" dates) as the most common
  // 4-digit year, falling back to today's.
  const yearTally = new Map<number, number>();
  for (let r = 1; r < records.length; r++) {
    const cell = records[r].fields[colIndex.get("date")!] ?? "";
    const ym = /(\d{4})/.exec(cell);
    if (ym) yearTally.set(+ym[1], (yearTally.get(+ym[1]) ?? 0) + 1);
  }
  const fileYear =
    [...yearTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    ctx.today.getUTCFullYear();

  const rows: RowResult[] = [];
  const seenHashes = new Set<string>();

  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    const rowNumber = r;
    summary.total++;
    const reasons: AnomalyCode[] = [];
    const messages: string[] = [];
    const add = (code: AnomalyCode, msg: string) => {
      reasons.push(code);
      messages.push(msg);
    };

    // EMPTY row.
    if (rec.fields.every((f) => norm(f) === "")) {
      summary.empty++;
      rows.push({
        rowNumber, raw: rec.raw, hash: rawHash(rec.raw || `empty-${rowNumber}`),
        outcome: "EMPTY", reasons: [ANOMALY.EMPTY_ROW], messages: [],
      });
      continue;
    }

    // MALFORMED (column count).
    if (rec.fields.length !== expectedWidth) {
      rows.push({
        rowNumber, raw: rec.raw, hash: rawHash(rec.raw), outcome: "REJECTED",
        reasons: [ANOMALY.MALFORMED_ROW],
        messages: [`Expected ${expectedWidth} columns, found ${rec.fields.length} — row skipped.`],
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
    const rawPayer = get("paid_by");
    const rawAmount = get("amount");
    const rawCurrency = get("currency");
    const rawSplitType = get("split_type");
    const rawWith = get("split_with");
    const rawDetails = get("split_details");
    const rawNotes = get("notes");

    if ([rawDate, rawDesc, rawPayer, rawAmount, rawWith].some((f) => f !== norm(f))) {
      summary.normalizedWhitespace++;
      reasons.push(ANOMALY.WHITESPACE_CASE);
      messages.push("Leading/trailing or mixed-case text was normalized.");
    }

    // Required fields.
    const required: [string, string][] = [
      ["date", rawDate], ["amount", rawAmount], ["paid_by", rawPayer], ["split_with", rawWith],
    ];
    const missing = required.filter(([, v]) => norm(v) === "").map(([k]) => k);
    if (missing.length > 0) {
      add(ANOMALY.MISSING_REQUIRED_FIELD, `Missing required field(s): ${missing.join(", ")} — row skipped.`);
    }

    // Amount (sign, precision, value). Negative => refund (magnitude parsed).
    let originalCents = 0;
    let isRefund = false;
    if (norm(rawAmount) !== "") {
      let amtText = norm(rawAmount);
      if (amtText.startsWith("-")) {
        isRefund = true;
        amtText = amtText.slice(1).trim();
      }
      const parsed = parseAmount(amtText);
      if (parsed.ok) {
        originalCents = parsed.cents;
        if (parsed.normalized) {
          add(ANOMALY.AMOUNT_NORMALIZED, `Amount '${norm(rawAmount)}' normalized.`);
        }
        if (isRefund) {
          add(ANOMALY.NEGATIVE_AMOUNT, "Negative amount treated as a refund (reversing entry) — imported and flagged.");
        }
      } else {
        const msgs: Record<string, string> = {
          INVALID_AMOUNT: `Amount '${norm(rawAmount)}' is not a valid number — row skipped.`,
          EXCESS_PRECISION: `Amount '${norm(rawAmount)}' has sub-unit precision — row skipped (amounts are never rounded silently).`,
          ZERO_AMOUNT: "Amount is zero — row skipped (no financial effect).",
          NEGATIVE_AMOUNT: `Amount '${norm(rawAmount)}' is invalid — row skipped.`,
          CURRENCY_MISMATCH: `Amount '${norm(rawAmount)}' is invalid — row skipped.`,
        };
        add(parsed.code as AnomalyCode, msgs[parsed.code] ?? "Invalid amount — row skipped.");
      }
    }

    // Currency -> convert to base.
    let currency = base;
    let amountCents = 0; // base minor units
    let fxRateBp = 100;
    {
      const cur = norm(rawCurrency).toUpperCase();
      if (cur === "") {
        currency = base;
        add(ANOMALY.MISSING_CURRENCY, `Currency missing — assumed group base (${base}) — imported and flagged.`);
      } else if (!isSupportedCurrency(cur)) {
        add(ANOMALY.UNSUPPORTED_CURRENCY, `Currency '${cur}' has no configured rate — row skipped.`);
        currency = cur;
      } else {
        currency = cur;
      }
      if (originalCents > 0 && isSupportedCurrency(currency)) {
        const conv = convertToBase(originalCents, currency);
        if (conv.ok) {
          amountCents = conv.baseMinor;
          fxRateBp = conv.fxRateBp;
          if (currency !== base) {
            summary.convertedCurrency++;
            add(
              ANOMALY.FOREIGN_CURRENCY,
              `${formatMoney(originalCents, currency)} converted to ${formatMoney(amountCents, base)} at 1 ${currency} = ${formatMoney(fxRateBp, base)} — imported.`,
            );
          }
        }
      }
    }

    // Date.
    let dateIso = "";
    if (norm(rawDate) !== "") {
      const d = parseDate(rawDate, fileYear);
      if (!d) {
        add(ANOMALY.INVALID_DATE, `Date '${norm(rawDate)}' is not a recognizable date — row skipped.`);
      } else {
        dateIso = d.iso;
        if (d.ambiguous) {
          add(ANOMALY.DATE_AMBIGUOUS, `Date '${norm(rawDate)}' → ${dateIso} (${d.ambiguous}) — imported and flagged.`);
        }
      }
    }

    // Split type (+ aliases). Empty handled later (could be a settlement).
    const stRaw = norm(rawSplitType).toUpperCase();
    let splitType: SplitType | null = stRaw === "" ? null : (SPLIT_TYPE_ALIASES[stRaw] ?? null);
    if (stRaw !== "" && !splitType) {
      add(ANOMALY.INVALID_SPLIT_TYPE, `Split type '${norm(rawSplitType)}' is not supported — row skipped.`);
    } else if (splitType && SPLIT_TYPE_ALIASES[stRaw] && stRaw !== splitType) {
      add(ANOMALY.SPLIT_TYPE_NORMALIZED, `Split type '${norm(rawSplitType)}' interpreted as ${splitType}.`);
    }

    // Payer.
    let payer: MemberCtx | null = null;
    if (norm(rawPayer) !== "") {
      const pm = resolveMember(rawPayer, ctx.members);
      if (pm.kind === "exact") payer = pm.member;
      else if (pm.kind === "ambiguous") {
        payer = pm.member;
        add(ANOMALY.AMBIGUOUS_IDENTITY, `Payer '${norm(rawPayer)}' matched to '${pm.member.name}' (closest member) — imported and flagged.`);
      } else {
        add(ANOMALY.UNKNOWN_USER, `Payer '${norm(rawPayer)}' is not a member of this group — row skipped.${pm.hint ? ` Closest: '${pm.hint.name}'.` : ""}`);
      }
    }

    // Participants.
    const tokens = norm(rawWith) === "" ? [] : rawWith.split(";").map((t) => norm(t)).filter(Boolean);
    const participants: MemberCtx[] = [];
    const seenIds = new Set<string>();
    for (const token of tokens) {
      const pm = resolveMember(token, ctx.members);
      if (pm.kind === "exact" || pm.kind === "ambiguous") {
        if (pm.kind === "ambiguous") {
          add(ANOMALY.AMBIGUOUS_IDENTITY, `Participant '${token}' matched to '${pm.member.name}' — imported and flagged.`);
        }
        if (seenIds.has(pm.member.userId)) {
          add(ANOMALY.DUPLICATE_PARTICIPANT, `'${token}' is listed more than once — row skipped.`);
        } else {
          seenIds.add(pm.member.userId);
          participants.push(pm.member);
        }
      } else {
        add(ANOMALY.UNKNOWN_USER, `Participant '${token}' is not a member of this group — row skipped.${pm.hint ? ` Closest: '${pm.hint.name}'.` : ""}`);
      }
    }

    // SETTLEMENT logged as expense: empty split_type + exactly one counterpart
    // that isn't the payer => a payment, not consumption.
    const fatalSoFar = reasons.some(
      (c) =>
        c === ANOMALY.MISSING_REQUIRED_FIELD || c === ANOMALY.INVALID_AMOUNT ||
        c === ANOMALY.EXCESS_PRECISION || c === ANOMALY.ZERO_AMOUNT ||
        c === ANOMALY.INVALID_DATE || c === ANOMALY.UNKNOWN_USER ||
        c === ANOMALY.UNSUPPORTED_CURRENCY || c === ANOMALY.INVALID_SPLIT_TYPE ||
        c === ANOMALY.DUPLICATE_PARTICIPANT,
    );

    if (
      !fatalSoFar && stRaw === "" && payer && participants.length === 1 &&
      participants[0].userId !== payer.userId && amountCents > 0
    ) {
      const settlement: ParsedSettlement = {
        date: dateIso, fromUserId: payer.userId, toUserId: participants[0].userId,
        currency, originalAmountCents: originalCents, amountCents, fxRateBp,
        note: norm(rawNotes) || norm(rawDesc) || undefined,
      };
      const hash = contentHash({
        date: dateIso, payerKey: payer.userId, amountCents, currency,
        participantKeys: [participants[0].userId], splitType: "SETTLEMENT", splitSpec: "",
      });
      // Idempotency: a re-uploaded settlement must not be recorded twice.
      if (seenHashes.has(hash) || ctx.existingHashes.has(hash)) {
        add(ANOMALY.DUPLICATE_ROW, seenHashes.has(hash)
          ? "Identical settlement to an earlier row in this file — skipped."
          : "This settlement was already imported in a previous batch — skipped.");
        rows.push({ rowNumber, raw: rec.raw, hash, outcome: "DUPLICATE", reasons, messages });
        summary.duplicate++;
        continue;
      }
      seenHashes.add(hash);
      add(ANOMALY.SETTLEMENT_AS_EXPENSE, `Looks like a payment, not an expense — recorded as a settlement from ${payer.name} to ${participants[0].name}.`);
      rows.push({ rowNumber, raw: rec.raw, hash, outcome: "RECLASSIFIED", reasons, messages, settlement });
      summary.reclassified++;
      continue;
    }

    // Default empty split type to EQUAL (with note) once it's not a settlement.
    if (stRaw === "" && !splitType) {
      splitType = "EQUAL";
      add(ANOMALY.SPLIT_TYPE_NORMALIZED, "Split type was blank — assumed EQUAL.");
    }

    // split_type vs split_details conflict (declared EQUAL but details present).
    const hasDetails = norm(rawDetails) !== "";
    if (splitType === "EQUAL" && hasDetails) {
      add(ANOMALY.SPLIT_TYPE_DETAIL_CONFLICT, "split_type is EQUAL but split_details were provided — honoring EQUAL, details ignored.");
    }

    // Membership timing (flag, not reject): everyone must be active on the date.
    if (dateIso) {
      for (const m of payer ? [payer, ...participants] : participants) {
        const joined = m.joinedAt.toISOString().slice(0, 10);
        const left = m.leftAt ? m.leftAt.toISOString().slice(0, 10) : null;
        if (joined > dateIso) {
          add(ANOMALY.MEMBERSHIP_TIMING, `'${m.name}' joined on ${joined}, after this expense (${dateIso}) — imported and flagged.`);
        } else if (left && left < dateIso) {
          add(ANOMALY.MEMBERSHIP_TIMING, `'${m.name}' left on ${left}, before this expense (${dateIso}) — imported and flagged.`);
        }
      }
    }

    // Compute base-currency shares from per-type weights.
    let splits: { userId: string; shareCents: number }[] = [];
    let splitSpecForHash = "";
    const canCompute = !fatalSoFar && splitType && participants.length > 0 && amountCents > 0;
    if (canCompute) {
      const sorted = [...participants].sort((a, b) => a.userId.localeCompare(b.userId));
      if (splitType === "EQUAL") {
        const shares = equalShares(amountCents, sorted.length);
        splits = sorted.map((m, i) => ({ userId: m.userId, shareCents: shares[i] }));
      } else {
        // Map split_details to participants.
        const details = parseSplitDetails(rawDetails);
        const byUser = new Map<string, string>();
        let specError = false;
        for (const dpair of details) {
          const pm = resolveMember(dpair.name, ctx.members);
          const mem = pm.kind === "none" ? null : pm.member;
          if (!mem || !seenIds.has(mem.userId) || dpair.value === "") {
            add(splitType === "PERCENTAGE" ? ANOMALY.PERCENT_SUM_MISMATCH : ANOMALY.SPLIT_SUM_MISMATCH,
              `Split detail '${dpair.name} ${dpair.value}' doesn't match this row's participants — row skipped.`);
            specError = true;
            break;
          }
          byUser.set(mem.userId, dpair.value);
        }
        if (!specError && byUser.size !== sorted.length) {
          add(splitType === "PERCENTAGE" ? ANOMALY.PERCENT_SUM_MISMATCH : ANOMALY.SPLIT_SUM_MISMATCH,
            `split_details covers ${byUser.size} of ${sorted.length} participants — row skipped.`);
          specError = true;
        }
        if (!specError) {
          splitSpecForHash = [...byUser.entries()].sort().map(([u, v]) => `${u}=${v}`).join(";");
          if (splitType === "EXACT") {
            const orig: number[] = [];
            for (const m of sorted) {
              const p = parseAmount(byUser.get(m.userId)!);
              if (!p.ok && p.code === "ZERO_AMOUNT") orig.push(0);
              else if (!p.ok) { add(ANOMALY.SPLIT_SUM_MISMATCH, `Exact amount for '${m.name}' is invalid — row skipped.`); specError = true; break; }
              else orig.push(p.cents);
            }
            if (!specError) {
              const sum = orig.reduce((a, b) => a + b, 0);
              if (sum !== originalCents) {
                add(ANOMALY.SPLIT_SUM_MISMATCH, `Exact splits total ${formatMoney(sum, currency)} but amount is ${formatMoney(originalCents, currency)} — row skipped.`);
              } else {
                // Allocate the BASE amount proportionally to the original-currency
                // shares (so base shares sum exactly to the base amount).
                const shares = weightedShares(amountCents, orig);
                splits = sorted.map((m, i) => ({ userId: m.userId, shareCents: shares[i] }));
              }
            }
          } else if (splitType === "PERCENTAGE") {
            const bps: number[] = [];
            for (const m of sorted) {
              const p = parsePercent(byUser.get(m.userId)!);
              if (!p.ok) { add(ANOMALY.PERCENT_SUM_MISMATCH, `Percentage for '${m.name}' is invalid — row skipped.`); specError = true; break; }
              bps.push(p.bp);
            }
            if (!specError) {
              const totalBp = bps.reduce((a, b) => a + b, 0);
              if (Math.abs(totalBp - 10000) > 1) {
                add(ANOMALY.PERCENT_SUM_MISMATCH, `Percentages total ${(totalBp / 100).toFixed(2)}% (not 100%) — row skipped.`);
              } else {
                const shares = weightedShares(amountCents, bps);
                splits = sorted.map((m, i) => ({ userId: m.userId, shareCents: shares[i] }));
              }
            }
          } else if (splitType === "SHARE") {
            const ratios: number[] = [];
            for (const m of sorted) {
              const v = byUser.get(m.userId)!;
              const n = Number(v);
              if (!Number.isInteger(n) || n <= 0) { add(ANOMALY.SPLIT_SUM_MISMATCH, `Share ratio for '${m.name}' must be a positive whole number — row skipped.`); specError = true; break; }
              ratios.push(n);
            }
            if (!specError) {
              const shares = weightedShares(amountCents, ratios);
              splits = sorted.map((m, i) => ({ userId: m.userId, shareCents: shares[i] }));
            }
          }
        }
      }
    }

    // Self-only (net zero).
    if (payer && participants.length === 1 && participants[0].userId === payer.userId) {
      add(ANOMALY.SELF_ONLY_EXPENSE, "Only the payer is involved — imported and flagged (no effect on balances).");
    } else if (payer && participants.length === 1 && participants[0].userId !== payer.userId && stRaw !== "") {
      // Payer covers a single other person (e.g. a deposit) — balance-correct but worth a look.
      add(ANOMALY.ONE_SIDED_EXPENSE, "Payer covers a single other person — imported and flagged (possible transfer).");
    }

    // Decide fatal vs flag. Notes/normalizations and "import-and-flag" codes are non-fatal.
    const NONFATAL: AnomalyCode[] = [
      ANOMALY.AMOUNT_NORMALIZED, ANOMALY.SPLIT_TYPE_NORMALIZED, ANOMALY.WHITESPACE_CASE,
      ANOMALY.FOREIGN_CURRENCY, ANOMALY.MISSING_CURRENCY, ANOMALY.DATE_AMBIGUOUS,
      ANOMALY.NEGATIVE_AMOUNT, ANOMALY.MEMBERSHIP_TIMING, ANOMALY.SELF_ONLY_EXPENSE,
      ANOMALY.ONE_SIDED_EXPENSE, ANOMALY.AMBIGUOUS_IDENTITY, ANOMALY.SPLIT_TYPE_DETAIL_CONFLICT,
      ANOMALY.CONFLICTING_DUPLICATE,
    ];
    const fatal = reasons.some((c) => !NONFATAL.includes(c)) || splits.length === 0;

    if (fatal) {
      rows.push({ rowNumber, raw: rec.raw, hash: rawHash(rec.raw), outcome: "REJECTED", reasons, messages });
      summary.rejected++;
      continue;
    }

    // Duplicate detection (content hash, description excluded).
    const hash = contentHash({
      date: dateIso, payerKey: payer!.userId, amountCents, currency,
      participantKeys: participants.map((p) => p.userId),
      splitType: splitType!, splitSpec: splitSpecForHash,
    });
    if (seenHashes.has(hash) || ctx.existingHashes.has(hash)) {
      add(ANOMALY.DUPLICATE_ROW, seenHashes.has(hash)
        ? "Identical to an earlier row in this file — skipped."
        : "Already imported in a previous batch — skipped.");
      rows.push({ rowNumber, raw: rec.raw, hash, outcome: "DUPLICATE", reasons, messages });
      summary.duplicate++;
      continue;
    }
    seenHashes.add(hash);

    const expense: ParsedExpense = {
      date: dateIso, description: norm(rawDesc) || "(no description)",
      currency, originalAmountCents: originalCents, amountCents, fxRateBp,
      paidById: payer!.userId, splitType: splitType!, splits,
      notes: norm(rawNotes) || undefined,
      isRefund: isRefund || undefined,
    };
    const flagged = reasons.length > 0;
    rows.push({
      rowNumber, raw: rec.raw, hash,
      outcome: flagged ? "FLAGGED" : "IMPORTED", reasons, messages, expense,
    });
    if (flagged) summary.flagged++;
    else summary.imported++;
  }

  // ---- post-pass: conflicting duplicates (same date + description signature,
  // different payer or amount) and out-of-sequence dates ----
  detectConflicts(rows, summary);
  detectDateSpikes(rows, summary);

  return { ok: true, rows, summary };
}

function isLiveExpense(row: RowResult): row is RowResult & { expense: ParsedExpense } {
  return (row.outcome === "IMPORTED" || row.outcome === "FLAGGED") && !!row.expense;
}

function detectConflicts(rows: RowResult[], summary: ValidationResult["summary"]): void {
  const byKey = new Map<string, RowResult[]>();
  for (const row of rows) {
    if (!isLiveExpense(row)) continue;
    const key = `${row.expense.date}|${descSignature(row.expense.description)}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(row);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const distinct = new Set(group.map((r) => `${r.expense!.paidById}|${r.expense!.amountCents}`));
    if (distinct.size < 2) continue; // identical -> handled by dedup, not a conflict
    for (const row of group) {
      if (row.reasons.includes(ANOMALY.CONFLICTING_DUPLICATE)) continue;
      row.reasons.push(ANOMALY.CONFLICTING_DUPLICATE);
      row.messages.push("Same day and description as another expense but a different payer/amount — both imported and flagged for you to resolve.");
      if (row.outcome === "IMPORTED") {
        row.outcome = "FLAGGED";
        summary.imported--;
        summary.flagged++;
      }
    }
  }
}

function detectDateSpikes(rows: RowResult[], summary: ValidationResult["summary"]): void {
  const live = rows.filter(isLiveExpense);
  for (let i = 1; i < live.length - 1; i++) {
    const prev = live[i - 1].expense.date;
    const cur = live[i].expense.date;
    const next = live[i + 1].expense.date;
    // A single row whose date jumps far above both neighbours is suspect
    // (e.g. "04-05-2026" = May 4 sitting between March and April rows).
    if (cur > prev && cur > next && daysBetween(cur, prev) > 20 && daysBetween(cur, next) > 20) {
      const row = live[i];
      if (!row.reasons.includes(ANOMALY.DATE_AMBIGUOUS)) {
        row.reasons.push(ANOMALY.DATE_AMBIGUOUS);
        row.messages.push(`Date ${cur} is out of chronological order with its neighbours — possibly DD-MM/MM-DD confusion. Imported as ${cur} and flagged.`);
        if (row.outcome === "IMPORTED") {
          row.outcome = "FLAGGED";
          summary.imported--;
          summary.flagged++;
        }
      }
    }
  }
}
