/**
 * Formatters for the numbers that show up in trace and telemetry UI.
 *
 * Both return `null` for missing or nonsensical input rather than a fallback
 * string, so each component picks its own em-dash placeholder and can keep the
 * "unknown" and "zero" cases visually distinct.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * A duration in milliseconds as a compact, scale-appropriate string:
 * `725ms`, `2.90s`, `1m 05s`, `2h 14m`.
 *
 * Sub-minute durations keep two decimals. Traces are compared by scanning a
 * column, and a fixed decimal count keeps the digits in vertical registration
 * (pair with `tabular-nums`); it also preserves the distinction between a
 * 2.90s and a 2.9s-rounded-from-2.85s run, which matters when durations are
 * the signal being read.
 */
export function formatDurationMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  if (ms < MS_PER_SECOND) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < MS_PER_MINUTE) {
    return `${(ms / MS_PER_SECOND).toFixed(2)}s`;
  }
  if (ms < MS_PER_HOUR) {
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    const seconds = Math.round((ms % MS_PER_MINUTE) / MS_PER_SECOND);
    // Rounding 59.6s up would print "3m 60s".
    return seconds === 60
      ? `${minutes + 1}m 00s`
      : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.round((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return minutes === 60 ? `${hours + 1}h 00m` : `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * A cost in USD. Sub-dollar amounts get four decimals because per-call LLM
 * spend lives in the fractions of a cent that two decimals would erase
 * (`$0.0076`, not `$0.01`); at a dollar and up, currency convention wins.
 *
 * Negative values (credits, refunds) are formatted with a leading minus.
 */
export function formatCost(usd: number | null | undefined): string | null {
  if (usd == null || !Number.isFinite(usd)) {
    return null;
  }
  const formatter = Math.abs(usd) < 1 && usd !== 0 ? SUB_DOLLAR_FORMAT : DOLLAR_FORMAT;
  return formatter.format(usd);
}

function usdFormat(digits: number): Intl.NumberFormat {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Constructing an Intl.NumberFormat resolves locale data; these are built once
// because formatCost runs per row.
const SUB_DOLLAR_FORMAT = usdFormat(4);
const DOLLAR_FORMAT = usdFormat(2);
