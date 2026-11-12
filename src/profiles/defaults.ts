import type { NetworkProfile } from "../types";

/**
 * Internal definition of a built-in profile. This is the ONLY place preset
 * values live; tune them here without touching the engine.
 */
export interface ProfileDefinition {
  /** Human-readable summary (used by documentation and tooling). */
  readonly description: string;
  /** Base additional latency in milliseconds. */
  readonly latency: number;
  /**
   * Internal latency jitter in milliseconds (not part of the public API).
   * The delay of each request varies by up to +/- `min(jitter, latency)`, so it
   * is never negative and averages the configured latency.
   */
  readonly jitter: number;
  /** Probability (0 to 1) that a request is intentionally failed. */
  readonly failureRate: number;
  /**
   * Whether user-supplied `latency` / `failureRate` overrides apply to this
   * profile. `offline` is absolute: every request must fail immediately.
   */
  readonly allowOverrides: boolean;
}

function define(definition: ProfileDefinition): ProfileDefinition {
  return Object.freeze({ ...definition });
}

/** Deeply frozen so shared presets can never be mutated by accident. */
export const PROFILE_DEFINITIONS: Readonly<Record<NetworkProfile, ProfileDefinition>> =
  Object.freeze({
    fast: define({
      description: "A healthy, fast network. No added latency and no failures.",
      latency: 0,
      jitter: 0,
      failureRate: 0,
      allowOverrides: true,
    }),
    "slow-3g": define({
      description: "A slow mobile network. Significant fixed latency, no failures.",
      latency: 2000,
      jitter: 0,
      failureRate: 0,
      allowOverrides: true,
    }),
    unstable: define({
      description: "An unreliable connection. Variable latency and intermittent failures.",
      latency: 800,
      jitter: 600,
      failureRate: 0.3,
      allowOverrides: true,
    }),
    "high-latency": define({
      description: "Consistently high latency with no jitter and no failures.",
      latency: 3000,
      jitter: 0,
      failureRate: 0,
      allowOverrides: true,
    }),
    offline: define({
      description: "No network. Every request fails immediately without reaching the network.",
      latency: 0,
      jitter: 0,
      failureRate: 1,
      allowOverrides: false,
    }),
  });
