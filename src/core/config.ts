import { NetChaosConfigError } from "../errors/NetChaosError";
import { PROFILE_NAMES, getProfileDefinition, isProfileName } from "../profiles";
import type { FetchLike, NetChaosConfig, NetworkProfile, RandomSource } from "../types";

/** Profile used when none is given. */
export const DEFAULT_PROFILE: NetworkProfile = "fast";

/** Largest delay `setTimeout` can honour (2^31 - 1 ms, roughly 24.8 days). */
export const MAX_LATENCY_MS = 2_147_483_647;

/** Custom overrides supplied by the user. Absent keys fall back to the profile. */
export interface Overrides {
  readonly latency?: number;
  readonly failureRate?: number;
}

/**
 * Fully resolved conditions for ONE request (internal). Includes `jitter`,
 * which is deliberately not part of the public API. Frozen, so a request that
 * captured it cannot be affected by later changes.
 */
export interface SimulationConfig {
  readonly profile: NetworkProfile;
  readonly latency: number;
  readonly jitter: number;
  readonly failureRate: number;
}

/** Validated, normalised constructor options. */
export interface NormalizedOptions {
  readonly profile: NetworkProfile;
  readonly overrides: Overrides;
  readonly fetch: FetchLike | undefined;
  readonly random: RandomSource | undefined;
}

export const EMPTY_OVERRIDES: Overrides = Object.freeze({});

const SUPPORTED_OPTIONS: readonly string[] = [
  "profile",
  "latency",
  "failureRate",
  "fetch",
  "random",
];

/** Short, safe description of a received value for error messages. */
function describe(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
  }
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a value of type ${typeof value}`;
}

export function assertProfileName(value: unknown): asserts value is NetworkProfile {
  if (!isProfileName(value)) {
    throw new NetChaosConfigError(
      `Unknown profile ${describe(value)}. Valid profiles: ${PROFILE_NAMES.join(", ")}.`,
    );
  }
}

export function assertLatency(value: unknown): asserts value is number {
  if (typeof value !== "number") {
    throw new NetChaosConfigError(
      `Invalid latency: expected a number of milliseconds, received ${describe(value)}.`,
    );
  }
  if (!Number.isFinite(value)) {
    throw new NetChaosConfigError(
      `Invalid latency: must be a finite number, received ${String(value)}.`,
    );
  }
  if (value < 0) {
    throw new NetChaosConfigError(
      `Invalid latency: must not be negative, received ${String(value)}.`,
    );
  }
  if (value > MAX_LATENCY_MS) {
    throw new NetChaosConfigError(
      `Invalid latency: must not exceed ${String(MAX_LATENCY_MS)} ms, received ${String(value)}.`,
    );
  }
}

export function assertFailureRate(value: unknown): asserts value is number {
  if (typeof value !== "number") {
    throw new NetChaosConfigError(
      `Invalid failureRate: expected a number between 0 and 1, received ${describe(value)}.`,
    );
  }
  if (!Number.isFinite(value)) {
    throw new NetChaosConfigError(
      `Invalid failureRate: must be a finite number between 0 and 1, received ${String(value)}.`,
    );
  }
  if (value < 0 || value > 1) {
    throw new NetChaosConfigError(
      `Invalid failureRate: must be between 0 and 1 inclusive, received ${String(value)}.`,
    );
  }
}

/**
 * Validates untrusted constructor options (JavaScript callers can pass anything)
 * and returns a normalised copy. Throws `NetChaosConfigError` on the first problem.
 * `undefined` values are treated as "not provided"; `null` is invalid.
 */
export function normalizeOptions(options: unknown): NormalizedOptions {
  const raw: unknown = options === undefined ? {} : options;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new NetChaosConfigError(
      `Invalid NetChaos options: expected an object, received ${describe(raw)}.`,
    );
  }
  const record = raw as Readonly<Record<string, unknown>>;

  const unknownKeys = Object.keys(record).filter((key) => !SUPPORTED_OPTIONS.includes(key));
  if (unknownKeys.length > 0) {
    throw new NetChaosConfigError(
      `Unknown NetChaos option(s): ${unknownKeys.map((k) => JSON.stringify(k)).join(", ")}. ` +
        `Supported options: ${SUPPORTED_OPTIONS.join(", ")}.`,
    );
  }

  const profile: unknown = record.profile === undefined ? DEFAULT_PROFILE : record.profile;
  assertProfileName(profile);

  const overrides: { latency?: number; failureRate?: number } = {};
  const latency: unknown = record.latency;
  if (latency !== undefined) {
    assertLatency(latency);
    overrides.latency = latency;
  }
  const failureRate: unknown = record.failureRate;
  if (failureRate !== undefined) {
    assertFailureRate(failureRate);
    overrides.failureRate = failureRate;
  }

  let fetchImpl: FetchLike | undefined;
  if (record.fetch !== undefined) {
    if (typeof record.fetch !== "function") {
      throw new NetChaosConfigError(
        `Invalid fetch option: expected a function, received ${describe(record.fetch)}.`,
      );
    }
    fetchImpl = record.fetch as FetchLike;
  }

  let randomImpl: RandomSource | undefined;
  if (record.random !== undefined) {
    if (typeof record.random !== "function") {
      throw new NetChaosConfigError(
        `Invalid random option: expected a function, received ${describe(record.random)}.`,
      );
    }
    randomImpl = record.random as RandomSource;
  }

  return Object.freeze({
    profile,
    overrides: Object.freeze(overrides),
    fetch: fetchImpl,
    random: randomImpl,
  });
}

/**
 * Combines a profile's defaults with the user's overrides into an immutable
 * snapshot. Overrides replace latency / failureRate; the profile's internal
 * jitter is always retained. Profiles with `allowOverrides: false` (offline)
 * ignore overrides entirely, so they stay absolute.
 */
export function resolveConfig(profile: NetworkProfile, overrides: Overrides): SimulationConfig {
  const definition = getProfileDefinition(profile);
  if (!definition.allowOverrides) {
    return Object.freeze({
      profile,
      latency: definition.latency,
      jitter: definition.jitter,
      failureRate: definition.failureRate,
    });
  }
  return Object.freeze({
    profile,
    latency: overrides.latency ?? definition.latency,
    jitter: definition.jitter,
    failureRate: overrides.failureRate ?? definition.failureRate,
  });
}

/** The public view of a resolved config (internal jitter is not exposed). */
export function toPublicConfig(config: SimulationConfig): NetChaosConfig {
  return Object.freeze({
    profile: config.profile,
    latency: config.latency,
    failureRate: config.failureRate,
  });
}
