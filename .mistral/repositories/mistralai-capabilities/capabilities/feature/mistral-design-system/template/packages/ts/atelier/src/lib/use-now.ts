"use client";

import { useEffect, useState } from "react";

/**
 * A ticking clock, shared by every row that needs one.
 *
 * Live elapsed timers are the obvious way to burn a fleet view: a list of 50
 * self-ticking rows is 50 intervals and 50 independent re-renders per second.
 * Hoisting the clock to the list means one interval and one render pass, and
 * every row's timer stays in lockstep instead of drifting apart.
 */
export function useNow(tickMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = enabled ? setInterval(() => setNow(Date.now()), tickMs) : undefined;
    return () => {
      if (id !== undefined) clearInterval(id);
    };
  }, [enabled, tickMs]);

  return now;
}
