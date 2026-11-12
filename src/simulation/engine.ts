import type { SimulationConfig } from "../core/config";
import { SimulatedNetworkError } from "../errors/NetChaosError";
import type { RandomSource } from "../types";
import { throwIfAborted } from "./abort";
import { shouldFail } from "./failure";
import { computeDelay, waitFor } from "./latency";

/** Everything the engine needs to simulate ONE request. */
export interface SimulationRequest {
  /** Immutable configuration captured when the request started. */
  readonly config: SimulationConfig;
  /** The signal that governs this request, if any. */
  readonly signal: AbortSignal | null | undefined;
  readonly random: RandomSource;
  /** Sends the request to the real Fetch implementation. Only called if it survives. */
  readonly forward: () => Promise<Response>;
}

/**
 * Runs one request through the simulation:
 *
 *   1. abort check -> 2. artificial latency (abortable) -> 3. abort check
 *   -> 4. failure roll -> 5. forward to the real fetch and return its Response.
 *
 * The Response and any native error from `forward` pass through untouched: the
 * engine never retries, wraps, clones or reads them. With zero latency nothing
 * is awaited before `forward`, so the underlying fetch starts synchronously.
 */
export async function runSimulation(request: SimulationRequest): Promise<Response> {
  const { config, signal, random, forward } = request;

  throwIfAborted(signal);

  const delay = computeDelay(config.latency, config.jitter, random);
  if (delay > 0) await waitFor(delay, signal);

  // Never forward a request that was aborted while we were waiting.
  throwIfAborted(signal);

  if (shouldFail(config.failureRate, random)) {
    throw new SimulatedNetworkError(config.profile);
  }

  return forward();
}
