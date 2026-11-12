import { NetChaosConfigError } from "../errors/NetChaosError";
import { defaultRandom } from "../simulation/random";
import type { FetchLike, NetChaosConfig, NetChaosOptions, NetworkProfile } from "../types";
import {
  EMPTY_OVERRIDES,
  assertProfileName,
  normalizeOptions,
  resolveConfig,
  toPublicConfig,
  type Overrides,
} from "./config";
import { createFetchWrapper } from "./fetch-wrapper";

/**
 * Captures the Fetch implementation that is global right now. It is captured
 * once, at creation, so that a later `globalThis.fetch = chaos.fetch` cannot
 * make NetChaos call itself recursively. Returns undefined if there is none.
 */
function captureGlobalFetch(): FetchLike | undefined {
  const candidate: unknown = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as FetchLike) : undefined;
}

/**
 * Simulates unreliable network conditions for requests made through
 * `chaos.fetch()`. It never modifies the global `fetch`.
 */
export class NetChaos {
  /**
   * Fetch-compatible function that applies the active network conditions.
   * It is bound to this instance, so it is safe to pass around detached:
   * `const { fetch } = chaos;`.
   */
  readonly fetch: FetchLike;

  #profile: NetworkProfile;
  #overrides: Overrides;

  /** @throws {NetChaosConfigError} If any option is invalid. */
  constructor(options?: NetChaosOptions) {
    const normalized = normalizeOptions(options);
    this.#profile = normalized.profile;
    this.#overrides = normalized.overrides;

    const underlying = normalized.fetch ?? captureGlobalFetch();
    const random = normalized.random ?? defaultRandom;

    this.fetch = createFetchWrapper({
      getConfig: () => resolveConfig(this.#profile, this.#overrides),
      getFetch: () => {
        if (underlying === undefined) {
          throw new NetChaosConfigError(
            "No Fetch implementation is available. Pass one with the `fetch` option, " +
              "for example createNetChaos({ fetch: myFetch }).",
          );
        }
        return underlying;
      },
      random,
    });
  }

  /** The currently active profile. */
  get profile(): NetworkProfile {
    return this.#profile;
  }

  /** The effective conditions (profile defaults plus custom overrides) for new requests. */
  getConfig(): NetChaosConfig {
    return toPublicConfig(resolveConfig(this.#profile, this.#overrides));
  }

  /**
   * Switches the active profile for all FUTURE requests. Requests already in
   * progress keep the configuration they started with. Custom `latency` /
   * `failureRate` overrides persist across switches (use `clearOverrides()` to
   * remove them), except that `"offline"` always fails and ignores them.
   *
   * @throws {NetChaosConfigError} If the profile name is unknown (the active profile is unchanged).
   */
  setProfile(profile: NetworkProfile): void {
    assertProfileName(profile);
    this.#profile = profile;
  }

  /**
   * Removes custom `latency` / `failureRate` overrides, restoring the active
   * profile's defaults. Affects future requests only.
   */
  clearOverrides(): void {
    this.#overrides = EMPTY_OVERRIDES;
  }
}

/** Creates a NetChaos instance. Equivalent to `new NetChaos(options)`. */
export function createNetChaos(options?: NetChaosOptions): NetChaos {
  return new NetChaos(options);
}
