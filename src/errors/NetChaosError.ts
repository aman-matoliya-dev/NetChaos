import type { NetworkProfile } from "../types";

/** Stable, machine-readable error codes. Prefer checking `code` over `instanceof`. */
export type NetChaosErrorCode = "NETCHAOS_INVALID_CONFIG" | "NETCHAOS_SIMULATED_FAILURE";

/** Base class for errors raised by NetChaos itself (not by the underlying fetch). */
export class NetChaosError extends Error {
  readonly code: NetChaosErrorCode;

  constructor(message: string, code: NetChaosErrorCode) {
    super(message);
    this.name = "NetChaosError";
    this.code = code;
  }
}

/** Thrown synchronously when a configuration value or option is invalid. */
export class NetChaosConfigError extends NetChaosError {
  constructor(message: string) {
    super(message, "NETCHAOS_INVALID_CONFIG");
    this.name = "NetChaosConfigError";
  }
}

/**
 * Rejection reason for an intentionally simulated network failure.
 *
 * It extends `TypeError` because that is what `fetch()` rejects with on a real
 * network failure, so existing error handling keeps working. The message never
 * contains request URLs, headers or bodies.
 */
export class SimulatedNetworkError extends TypeError {
  readonly code = "NETCHAOS_SIMULATED_FAILURE" as const;
  /** The profile that was active when the request started. */
  readonly profile: NetworkProfile;

  constructor(profile: NetworkProfile) {
    super(`NetChaos: simulated network failure (profile: "${profile}")`);
    this.name = "SimulatedNetworkError";
    this.profile = profile;
  }
}
