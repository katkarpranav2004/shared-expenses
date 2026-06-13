// Multi-currency support. The group has ONE base currency (INR); every amount
// is converted to base at import/entry time using a documented snapshot rate,
// and we store the original amount + the rate used so the conversion is
// reproducible and auditable (DECISIONS #16). Balance math is always in base
// minor units (paise), so Σ net == 0 holds.

// Snapshot rates: INR per 1 unit of the currency, expressed in basis points
// (rate × 100) so we never store a float. 1 USD = ₹83.00 as of 2026-03-01.
// To refresh: change the value and document the date here.
export const FX_SNAPSHOT_DATE = "2026-03-01";
export const FX_RATE_BP: Record<string, number> = {
  INR: 100, // base: 1 INR = ₹1.00
  USD: 8300, // 1 USD = ₹83.00
};

export const BASE_CURRENCY = "INR";

export function isSupportedCurrency(code: string): boolean {
  return code.toUpperCase() in FX_RATE_BP;
}

// Convert an amount in `currency` minor units to base (INR paise).
// baseMinor = originalMinor × rateBp / 100  (rounded to nearest paisa).
// USD example: 540 USD = 54000 cents → 54000 × 8300/100 = 4,482,000 paise = ₹44,820.
export function convertToBase(
  originalMinor: number,
  currency: string,
): { ok: true; baseMinor: number; fxRateBp: number } | { ok: false } {
  const code = currency.toUpperCase();
  const fxRateBp = FX_RATE_BP[code];
  if (fxRateBp === undefined) return { ok: false };
  const baseMinor = Math.round((originalMinor * fxRateBp) / 100);
  return { ok: true, baseMinor, fxRateBp };
}

const SYMBOL: Record<string, string> = { INR: "₹", USD: "$" };

// Format minor units of a given currency for display ("$540.00", "₹44,820.00").
export function formatMoney(minor: number, currency = BASE_CURRENCY): string {
  const code = currency.toUpperCase();
  const symbol = SYMBOL[code] ?? `${code} `;
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}${symbol}${whole.toLocaleString("en-US")}.${frac}`;
}
