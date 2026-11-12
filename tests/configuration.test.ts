import { describe, expect, it } from "vitest";
import { NetChaos, NetChaosConfigError, NetChaosError, createNetChaos } from "../src";
import type { NetChaosOptions, NetworkProfile } from "../src";
import {
  EMPTY_OVERRIDES,
  MAX_LATENCY_MS,
  normalizeOptions,
  resolveConfig,
  toPublicConfig,
} from "../src/core/config";
import { describeValue, returnValueOf, thrown } from "./helpers";

/** Lets tests pass deliberately invalid values the way a JavaScript caller could. */
const loose = (value: unknown): NetChaosOptions => value as NetChaosOptions;

function expectConfigError(fn: () => unknown, pattern: RegExp): void {
  const error = thrown(fn);
  expect(error).toBeInstanceOf(NetChaosConfigError);
  expect(error).toBeInstanceOf(NetChaosError);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: "NETCHAOS_INVALID_CONFIG", name: "NetChaosConfigError" });
  expect((error as Error).message).toMatch(pattern);
}

describe("creating an instance", () => {
  it("works with no options and defaults to the fast profile", () => {
    expect(createNetChaos().getConfig()).toEqual({ profile: "fast", latency: 0, failureRate: 0 });
    expect(new NetChaos().profile).toBe("fast");
  });

  it("treats undefined option values as 'not provided'", () => {
    const chaos = createNetChaos({
      profile: undefined,
      latency: undefined,
      failureRate: undefined,
    });
    expect(chaos.getConfig()).toEqual({ profile: "fast", latency: 0, failureRate: 0 });
  });

  it("createNetChaos and the constructor are equivalent", () => {
    const options = { profile: "unstable", latency: 10, failureRate: 0.5 } as const;
    expect(createNetChaos(options)).toBeInstanceOf(NetChaos);
    expect(createNetChaos(options).getConfig()).toEqual(new NetChaos(options).getConfig());
  });

  it("accepts a frozen options object and does not mutate it", () => {
    const options = Object.freeze({ profile: "slow-3g", latency: 5 } as const);
    expect(createNetChaos(options).getConfig().latency).toBe(5);
    expect(options).toEqual({ profile: "slow-3g", latency: 5 });
  });

  it("does not retain the caller's options object (later edits have no effect)", () => {
    const options = { profile: "slow-3g" as NetworkProfile, latency: 10, failureRate: 0.2 };
    const chaos = createNetChaos(options);
    options.latency = 9999;
    options.failureRate = 1;
    options.profile = "offline";
    expect(chaos.getConfig()).toEqual({ profile: "slow-3g", latency: 10, failureRate: 0.2 });
  });
});

describe("custom overrides", () => {
  const overridable: readonly NetworkProfile[] = ["fast", "slow-3g", "unstable", "high-latency"];

  for (const profile of overridable) {
    it(`custom latency overrides the ${profile} profile's latency only`, () => {
      const defaults = createNetChaos({ profile }).getConfig();
      const config = createNetChaos({ profile, latency: 1234 }).getConfig();
      expect(config).toEqual({ profile, latency: 1234, failureRate: defaults.failureRate });
    });

    it(`custom failureRate overrides the ${profile} profile's failureRate only`, () => {
      const defaults = createNetChaos({ profile }).getConfig();
      const config = createNetChaos({ profile, failureRate: 0.42 }).getConfig();
      expect(config).toEqual({ profile, latency: defaults.latency, failureRate: 0.42 });
    });
  }

  it("applies both overrides together (spec example)", () => {
    const chaos = createNetChaos({ profile: "slow-3g", latency: 3000, failureRate: 0.1 });
    expect(chaos.getConfig()).toEqual({ profile: "slow-3g", latency: 3000, failureRate: 0.1 });
  });

  it("allows overrides on their own, without choosing a profile", () => {
    expect(createNetChaos({ latency: 250 }).getConfig()).toEqual({
      profile: "fast",
      latency: 250,
      failureRate: 0,
    });
  });

  it("an explicit 0 override is respected, not treated as 'missing'", () => {
    const config = createNetChaos({ profile: "unstable", latency: 0, failureRate: 0 }).getConfig();
    expect(config).toEqual({ profile: "unstable", latency: 0, failureRate: 0 });
  });

  it("accepts boundary values", () => {
    expect(() => createNetChaos({ latency: 0, failureRate: 0 })).not.toThrow();
    expect(() => createNetChaos({ latency: 0, failureRate: 1 })).not.toThrow();
    expect(() => createNetChaos({ latency: MAX_LATENCY_MS })).not.toThrow();
    expect(() => createNetChaos({ latency: 0.5, failureRate: 0.000001 })).not.toThrow();
  });
});

describe("override persistence and clearOverrides()", () => {
  it("overrides persist across setProfile()", () => {
    const chaos = createNetChaos({ profile: "slow-3g", latency: 3000, failureRate: 0.1 });
    chaos.setProfile("high-latency");
    expect(chaos.getConfig()).toEqual({ profile: "high-latency", latency: 3000, failureRate: 0.1 });
    chaos.setProfile("unstable");
    expect(chaos.getConfig()).toEqual({ profile: "unstable", latency: 3000, failureRate: 0.1 });
    chaos.setProfile("fast");
    expect(chaos.getConfig()).toEqual({ profile: "fast", latency: 3000, failureRate: 0.1 });
  });

  it("offline ignores overrides, preserves them, and they apply again afterwards", () => {
    const chaos = createNetChaos({ profile: "slow-3g", latency: 3000, failureRate: 0.1 });
    chaos.setProfile("offline");
    expect(chaos.getConfig()).toEqual({ profile: "offline", latency: 0, failureRate: 1 });
    chaos.setProfile("high-latency");
    expect(chaos.getConfig()).toEqual({ profile: "high-latency", latency: 3000, failureRate: 0.1 });
  });

  it("offline created WITH overrides ignores them but keeps them for later", () => {
    const chaos = createNetChaos({ profile: "offline", latency: 500, failureRate: 0.25 });
    expect(chaos.getConfig()).toEqual({ profile: "offline", latency: 0, failureRate: 1 });
    chaos.setProfile("fast");
    expect(chaos.getConfig()).toEqual({ profile: "fast", latency: 500, failureRate: 0.25 });
  });

  it("clearOverrides() restores the active profile's defaults", () => {
    const chaos = createNetChaos({ profile: "slow-3g", latency: 3000, failureRate: 0.1 });
    chaos.clearOverrides();
    expect(chaos.getConfig()).toEqual({ profile: "slow-3g", latency: 2000, failureRate: 0 });
    chaos.setProfile("unstable");
    expect(chaos.getConfig()).toEqual({ profile: "unstable", latency: 800, failureRate: 0.3 });
  });

  it("clearOverrides() while offline still removes them for every later profile", () => {
    const chaos = createNetChaos({ profile: "offline", latency: 500, failureRate: 0.25 });
    chaos.clearOverrides();
    chaos.setProfile("slow-3g");
    expect(chaos.getConfig()).toEqual({ profile: "slow-3g", latency: 2000, failureRate: 0 });
  });

  it("clearOverrides() is idempotent and safe with no overrides", () => {
    const chaos = createNetChaos({ profile: "high-latency" });
    expect(returnValueOf(chaos.clearOverrides.bind(chaos))).toBeUndefined();
    chaos.clearOverrides();
    expect(chaos.getConfig()).toEqual({ profile: "high-latency", latency: 3000, failureRate: 0 });
  });

  it("clearOverrides() leaves the active profile unchanged", () => {
    const chaos = createNetChaos({ profile: "unstable", latency: 1 });
    chaos.clearOverrides();
    expect(chaos.profile).toBe("unstable");
  });

  it("setProfile() to the same profile is a harmless no-op", () => {
    const chaos = createNetChaos({ profile: "slow-3g", latency: 77 });
    chaos.setProfile("slow-3g");
    expect(chaos.getConfig()).toEqual({ profile: "slow-3g", latency: 77, failureRate: 0 });
  });

  it("getConfig() returns a frozen snapshot that does not track later changes", () => {
    const chaos = createNetChaos({ profile: "slow-3g" });
    const snapshot = chaos.getConfig();
    expect(Object.isFrozen(snapshot)).toBe(true);
    chaos.setProfile("offline");
    expect(snapshot.profile).toBe("slow-3g");
    expect(Reflect.set(snapshot, "latency", 1)).toBe(false);
  });
});

describe("configuration validation", () => {
  const badLatencies: [unknown, RegExp][] = [
    [-1, /negative/],
    [-0.001, /negative/],
    [Number.NEGATIVE_INFINITY, /finite/],
    [Number.POSITIVE_INFINITY, /finite/],
    [Number.NaN, /finite/],
    [MAX_LATENCY_MS + 1, /must not exceed/],
    ["100", /expected a number/],
    [null, /expected a number/],
    [true, /expected a number/],
    [{}, /expected a number/],
    [[], /expected a number/],
  ];
  for (const [value, pattern] of badLatencies) {
    it(`rejects latency ${describeValue(value)}`, () => {
      expectConfigError(() => createNetChaos(loose({ latency: value })), pattern);
    });
  }

  const badRates: [unknown, RegExp][] = [
    [-0.1, /between 0 and 1/],
    [-Number.EPSILON, /between 0 and 1/],
    [1.0001, /between 0 and 1/],
    [2, /between 0 and 1/],
    [Number.POSITIVE_INFINITY, /finite/],
    [Number.NaN, /finite/],
    ["0.5", /expected a number/],
    [null, /expected a number/],
    [true, /expected a number/],
    [{}, /expected a number/],
  ];
  for (const [value, pattern] of badRates) {
    it(`rejects failureRate ${describeValue(value)}`, () => {
      expectConfigError(() => createNetChaos(loose({ failureRate: value })), pattern);
    });
  }

  const badProfiles: unknown[] = ["unknown", "", "FAST", null, 5, true, {}, []];
  for (const value of badProfiles) {
    it(`rejects profile ${JSON.stringify(value)}`, () => {
      expectConfigError(() => createNetChaos(loose({ profile: value })), /Unknown profile/);
    });
  }

  const badOptionObjects: [string, unknown][] = [
    ["null", null],
    ["a number", 5],
    ["a string", "fast"],
    ["a boolean", true],
    ["an array", []],
    ["a function", () => undefined],
  ];
  for (const [label, value] of badOptionObjects) {
    it(`rejects ${label} instead of an options object`, () => {
      expectConfigError(() => createNetChaos(loose(value)), /expected an object/);
    });
  }

  for (const key of ["jitter", "failurerate", "latencyMs", "extra", "Profile"]) {
    it(`rejects the unsupported option "${key}" (typos and jitter are not public)`, () => {
      const error = thrown(() => createNetChaos(loose({ [key]: 1 })));
      expect(error).toBeInstanceOf(NetChaosConfigError);
      expect((error as Error).message).toContain(`"${key}"`);
      expect((error as Error).message).toContain("Supported options");
    });
  }

  it("rejects a non-function fetch or random option", () => {
    expectConfigError(() => createNetChaos(loose({ fetch: "nope" })), /Invalid fetch/);
    expectConfigError(() => createNetChaos(loose({ fetch: null })), /Invalid fetch/);
    expectConfigError(() => createNetChaos(loose({ random: 0.5 })), /Invalid random/);
  });

  it("throws synchronously from createNetChaos (never returns a rejected promise)", () => {
    expect(() => createNetChaos({ latency: -1 })).toThrow(NetChaosConfigError);
  });

  it("reports the FIRST invalid value, never silently accepting any", () => {
    expectConfigError(() => createNetChaos({ profile: "fast", latency: 5, failureRate: 5 }), /failureRate/);
  });

  it("truncates very long received values in error messages", () => {
    const error = thrown(() => createNetChaos(loose({ profile: "x".repeat(500) })));
    expect((error as Error).message.length).toBeLessThan(200);
    expect((error as Error).message).toContain("...");
  });
});

describe("normalizeOptions / resolveConfig / toPublicConfig (internals)", () => {
  it("normalizeOptions returns frozen, normalised options with defaults", () => {
    const normalized = normalizeOptions(undefined);
    expect(normalized.profile).toBe("fast");
    expect(normalized.overrides).toEqual({});
    expect(normalized.fetch).toBeUndefined();
    expect(normalized.random).toBeUndefined();
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.overrides)).toBe(true);
  });

  it("normalizeOptions keeps only the overrides that were supplied", () => {
    expect(normalizeOptions({ latency: 5 }).overrides).toEqual({ latency: 5 });
    expect(normalizeOptions({ failureRate: 0 }).overrides).toEqual({ failureRate: 0 });
  });

  it("resolveConfig retains the profile's internal jitter when latency is overridden", () => {
    expect(resolveConfig("unstable", { latency: 100 })).toEqual({
      profile: "unstable",
      latency: 100,
      jitter: 600,
      failureRate: 0.3,
    });
  });

  it("resolveConfig applies overrides to every overridable profile", () => {
    const overrides = { latency: 11, failureRate: 0.22 };
    for (const profile of ["fast", "slow-3g", "unstable", "high-latency"] as const) {
      const resolved = resolveConfig(profile, overrides);
      expect(resolved.latency).toBe(11);
      expect(resolved.failureRate).toBe(0.22);
    }
  });

  it("resolveConfig ignores overrides for offline", () => {
    expect(resolveConfig("offline", { latency: 9999, failureRate: 0 })).toEqual({
      profile: "offline",
      latency: 0,
      jitter: 0,
      failureRate: 1,
    });
  });

  it("resolveConfig returns a frozen result and never mutates its inputs", () => {
    const overrides = Object.freeze({ latency: 10 });
    const resolved = resolveConfig("slow-3g", overrides);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(overrides).toEqual({ latency: 10 });
    expect(resolveConfig("slow-3g", EMPTY_OVERRIDES).latency).toBe(2000);
  });

  it("toPublicConfig strips jitter and is frozen", () => {
    const publicConfig = toPublicConfig(resolveConfig("unstable", EMPTY_OVERRIDES));
    expect(publicConfig).toEqual({ profile: "unstable", latency: 800, failureRate: 0.3 });
    expect("jitter" in publicConfig).toBe(false);
    expect(Object.isFrozen(publicConfig)).toBe(true);
  });
});

describe("multiple instances stay independent", () => {
  it("do not share profile, overrides, or configuration", () => {
    const a = createNetChaos({ profile: "slow-3g", latency: 111, failureRate: 0.1 });
    const b = createNetChaos({ profile: "unstable" });
    a.setProfile("high-latency");
    expect(b.getConfig()).toEqual({ profile: "unstable", latency: 800, failureRate: 0.3 });
    b.setProfile("offline");
    expect(a.getConfig()).toEqual({ profile: "high-latency", latency: 111, failureRate: 0.1 });
    a.clearOverrides();
    expect(b.profile).toBe("offline");
    b.setProfile("slow-3g");
    expect(b.getConfig()).toEqual({ profile: "slow-3g", latency: 2000, failureRate: 0 });
    expect(a.getConfig()).toEqual({ profile: "high-latency", latency: 3000, failureRate: 0 });
  });

  it("each instance has its own fetch function", () => {
    expect(createNetChaos().fetch).not.toBe(createNetChaos().fetch);
  });

  it("many instances created from the same options object are independent", () => {
    const options = { profile: "slow-3g", latency: 10 } as const;
    const instances = Array.from({ length: 5 }, () => createNetChaos(options));
    instances[0]?.setProfile("offline");
    instances[1]?.clearOverrides();
    expect(instances[2]?.getConfig()).toEqual({ profile: "slow-3g", latency: 10, failureRate: 0 });
    expect(instances[1]?.getConfig()).toEqual({ profile: "slow-3g", latency: 2000, failureRate: 0 });
  });
});
