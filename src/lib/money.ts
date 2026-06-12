// All money in this codebase is integer cents. This module is the ONLY place
// that converts between human-entered strings and cents, so the parsing policy
// (SCOPE.md A3-A6) lives in exactly one spot.

export type AmountParse =
  | { ok: true; cents: number; normalized: boolean }
  | {
      ok: false;
      code:
        | "INVALID_AMOUNT"
        | "EXCESS_PRECISION"
        | "NEGATIVE_AMOUNT"
        | "ZERO_AMOUNT"
        | "CURRENCY_MISMATCH";
    };

const FOREIGN_CURRENCY = /€|£|¥|₹|\b(EUR|GBP|INR|JPY|AUD|CAD)\b/i;
// Strict grouping: "1,200" / "1,200,300.50" are thousands separators;
// "12,50" is NOT (ambiguous EU decimal comma) and must be rejected, not guessed.
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
const PLAIN = /^\d+(\.\d+)?$/;

export function parseAmount(raw: string): AmountParse {
  let s = raw.trim();
  let normalized = s !== raw;

  if (s === "") return { ok: false, code: "INVALID_AMOUNT" };
  if (FOREIGN_CURRENCY.test(s)) return { ok: false, code: "CURRENCY_MISMATCH" };

  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }
  if (s.startsWith("$") || s.toUpperCase().startsWith("USD")) {
    s = s.replace(/^\$|^USD/i, "").trim();
    normalized = true;
  }
  // a second sign after the symbol, e.g. "$-5"
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }

  if (GROUPED.test(s)) {
    s = s.replace(/,/g, "");
    normalized = true;
  }
  if (!PLAIN.test(s)) return { ok: false, code: "INVALID_AMOUNT" };

  const [whole, frac = ""] = s.split(".");
  if (frac.length > 2) return { ok: false, code: "EXCESS_PRECISION" };

  // String math: no parseFloat anywhere near money.
  const cents = parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, "0") || "0", 10);
  if (!Number.isSafeInteger(cents)) return { ok: false, code: "INVALID_AMOUNT" };
  if (negative) return { ok: false, code: "NEGATIVE_AMOUNT" };
  if (cents === 0) return { ok: false, code: "ZERO_AMOUNT" };

  return { ok: true, cents, normalized };
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${frac}`;
}

// Percentages are held as integer basis points (1% = 100 bp) for the same
// reason amounts are cents: no floats. "33.33" -> 3333 bp.
export function parsePercent(raw: string): { ok: true; bp: number } | { ok: false } {
  const s = raw.trim().replace(/%$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false };
  const [whole, frac = ""] = s.split(".");
  return { ok: true, bp: parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, "0") || "0", 10) };
}
