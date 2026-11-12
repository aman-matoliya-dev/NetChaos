/** Names of the built-in network profiles. */
export type NetworkProfile = "fast" | "slow-3g" | "unstable" | "high-latency" | "offline";

/**
 * A Fetch-compatible function. The global `fetch` of browsers and Node.js 18+
 * is assignable to this type.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * A source of randomness with the same contract as `Math.random`: it returns a
 * number in the range [0, 1).
 */
export type RandomSource = () => number;

/** Custom network conditions that override the values of the selected profile. */
export interface CustomConditions {
  /**
   * Additional artificial latency in milliseconds. Must be a finite number >= 0.
   * Replaces the selected profile's base latency.
   */
  latency?: number;
  /**
   * Probability (0 to 1) that a request is intentionally failed.
   * `0` never fails, `1` always fails. Replaces the selected profile's failure rate.
   */
  failureRate?: number;
}

/** Options accepted by `createNetChaos()` and the `NetChaos` constructor. */
export interface NetChaosOptions extends CustomConditions {
  /** Initial network profile. Defaults to `"fast"`. */
  profile?: NetworkProfile;
  /**
   * Advanced / testing: the underlying Fetch implementation that surviving
   * requests are forwarded to. Defaults to the `fetch` that is global when the
   * instance is created. It is called as a plain function (no `this`).
   */
  fetch?: FetchLike;
  /**
   * Advanced / testing: replaces `Math.random` for jitter and failure decisions.
   * Must return a number in the range [0, 1).
   */
  random?: RandomSource;
}

/** The effective network conditions currently applied to new requests. */
export interface NetChaosConfig {
  readonly profile: NetworkProfile;
  /** Effective base latency in milliseconds (profile default or custom override). */
  readonly latency: number;
  /** Effective failure probability from 0 to 1 (profile default or custom override). */
  readonly failureRate: number;
}
