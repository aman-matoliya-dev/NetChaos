import { runSimulation } from "../simulation/engine";
import type { FetchLike, RandomSource } from "../types";
import type { SimulationConfig } from "./config";

export interface FetchWrapperDeps {
  /** Returns the configuration for a NEW request. Called synchronously at call time. */
  readonly getConfig: () => SimulationConfig;
  /** Returns the underlying Fetch implementation. Called only when a request survives. */
  readonly getFetch: () => FetchLike;
  readonly random: RandomSource;
}

type SignalShape = Partial<Record<"aborted" | "addEventListener" | "removeEventListener", unknown>>;

function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as SignalShape;
  return (
    typeof candidate.aborted === "boolean" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  );
}

/**
 * Determines the signal that governs a request, exactly as native `fetch` does:
 * `init.signal` REPLACES a `Request`'s own signal (they are not merged), an
 * explicit `null` means "no signal", and `undefined` falls back to the Request's
 * signal. The simulated delay therefore observes the same signal the real fetch
 * would, and the original arguments are forwarded untouched.
 */
export function resolveSignal(
  input: RequestInfo | URL,
  init: RequestInit | null | undefined,
): AbortSignal | null | undefined {
  let candidate: unknown;
  if (init?.signal !== undefined) {
    candidate = init.signal;
  } else if (typeof input === "object" && "signal" in input) {
    candidate = (input as { signal?: unknown }).signal;
  }

  if (candidate === undefined || candidate === null) return candidate;
  if (!isAbortSignalLike(candidate)) {
    throw new TypeError("NetChaos: the 'signal' option is not an AbortSignal.");
  }
  return candidate;
}

/**
 * Creates a Fetch-compatible function that applies the simulation before
 * delegating to the underlying fetch. It never throws synchronously (like
 * `fetch`), and it forwards the caller's arguments exactly as received.
 */
export function createFetchWrapper(deps: FetchWrapperDeps): FetchLike {
  // `async` turns any synchronous exception (for example an invalid signal) into a rejected
  // promise, like native fetch. An async function still runs synchronously up to its first
  // `await`, so the configuration snapshot below is taken at call time.
  return async (...args: Parameters<FetchLike>): Promise<Response> => {
    const [input, init] = args;
    // Snapshot NOW, synchronously: later setProfile() calls cannot affect this request.
    const config = deps.getConfig();
    const signal = resolveSignal(input, init);
    return runSimulation({
      config,
      signal,
      random: deps.random,
      forward: () => deps.getFetch()(...args),
    });
  };
}
