import { vi } from "vitest";
import type { FetchLike, RandomSource } from "../src/types";

export type Settled<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

/**
 * Attaches handlers to a promise IMMEDIATELY and reports how it settled.
 * Using this avoids unhandled-rejection noise when a promise rejects before the
 * test reaches its assertion (for example while fake timers are advancing).
 */
export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ status: "fulfilled", value }),
    (reason: unknown): Settled<T> => ({ status: "rejected", reason }),
  );
}

/** Runs `fn` and returns whatever it throws; fails if it does not throw. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the function to throw, but it returned normally.");
}

/** A mock Fetch implementation that resolves with a fresh `Response("ok")` by default. */
export function createMockFetch(impl?: FetchLike) {
  return vi.fn<FetchLike>(impl ?? (() => Promise.resolve(new Response("ok"))));
}

/** Returns the arguments of the n-th call, failing loudly if there was none. */
export function callArgs(
  mock: { mock: { calls: Parameters<FetchLike>[] } },
  index = 0,
): Parameters<FetchLike> {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`Expected underlying fetch call #${String(index)} to exist.`);
  return call;
}

/**
 * A promise that rejects with exactly `reason`, whatever its type. Native fetch rejects with
 * arbitrary values (for example an AbortSignal's custom reason), which tests must be able to
 * simulate; `throw` of an unknown value is allowed where `reject(unknown)` is not.
 */
export function rejectingWith(reason: unknown): Promise<never> {
  return Promise.resolve().then(() => {
    throw reason;
  });
}

/** A Fetch that never settles by itself but rejects like native fetch when its signal aborts. */
export function createAbortAwareFetch(): FetchLike {
  return (_input, init) => {
    const signal = init?.signal;
    if (signal?.aborted) return rejectingWith(signal.reason);
    return new Promise<void>((resolve) => {
      signal?.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
    }).then(() => rejectingWith(signal?.reason));
  };
}

/** Starts a request and fails the test if the call throws synchronously (fetch must only reject). */
export function startWithoutThrowing<T>(start: () => Promise<T>): Promise<T> {
  try {
    return start();
  } catch (error) {
    throw new Error("Expected a rejected promise, but the call threw synchronously.", {
      cause: error,
    });
  }
}

/** Calls a void-typed method and returns what it actually returned at runtime. */
export function returnValueOf(method: () => void): unknown {
  const call: () => unknown = method;
  return call();
}

/** A short, stable label for any value, for use in test titles. */
export function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function" || typeof value === "symbol") return typeof value;
  return JSON.stringify(value);
}

export interface Sequence extends RandomSource {
  /** How many values have been drawn so far. */
  readonly drawn: () => number;
}

/** A deterministic RandomSource that returns `values` in order, then throws. */
export function sequence(values: readonly number[]): Sequence {
  let index = 0;
  const next = (() => {
    const value = values[index];
    if (value === undefined) throw new Error("Test random sequence exhausted.");
    index += 1;
    return value;
  }) as Sequence;
  (next as { drawn: () => number }).drawn = () => index;
  return next;
}

/** Small deterministic PRNG (mulberry32) returning numbers in [0, 1). */
export function mulberry32(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Counts add/removeEventListener calls on an AbortSignal. */
export function trackSignal(controller: AbortController = new AbortController()) {
  const { signal } = controller;
  const counts = { added: 0, removed: 0 };
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => {
    counts.added += 1;
    add(...args);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    counts.removed += 1;
    remove(...args);
  }) as typeof signal.removeEventListener;
  return { controller, signal, counts };
}
