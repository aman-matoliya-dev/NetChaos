import { MAX_LATENCY_MS } from "../core/config";
import type { RandomSource } from "../types";
import { createAbortError, throwIfAborted } from "./abort";
import { drawUnit } from "./random";

/**
 * Computes one request's artificial delay in milliseconds.
 *
 * Without jitter the delay is exactly `latency` and no randomness is consumed.
 * With jitter it is uniformly distributed in `latency +/- min(jitter, latency)`,
 * so it is never negative and its mean equals `latency`.
 */
export function computeDelay(latency: number, jitter: number, random: RandomSource): number {
  if (!(latency > 0)) return 0;
  const spread = Math.min(jitter, latency);
  if (!(spread > 0)) return Math.min(latency, MAX_LATENCY_MS);
  const offset = (drawUnit(random) * 2 - 1) * spread;
  return Math.min(Math.max(latency + offset, 0), MAX_LATENCY_MS);
}

/**
 * Resolves after `ms` milliseconds, or rejects as soon as `signal` aborts.
 *
 * - Already-aborted signals reject immediately and never start a timer.
 * - The timer and the abort listener are always removed, whichever side wins.
 * - The rejection reason is exactly the signal's own reason (any value, as with native
 *   fetch), so it is re-thrown as-is rather than wrapped in an Error.
 */
export async function waitFor(ms: number, signal?: AbortSignal | null): Promise<void> {
  throwIfAborted(signal);
  if (!(ms > 0)) return;

  const elapsed = await new Promise<boolean>((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve(false);
    };
    const onTimeout = (): void => {
      cleanup();
      resolve(true);
    };

    const timer = setTimeout(onTimeout, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  if (!elapsed) throw createAbortError(signal);
}
