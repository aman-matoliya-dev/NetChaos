import { describe, expect, it } from "vitest";
import { NetChaos, NetChaosConfigError, createNetChaos, type NetworkProfile } from "../src";
import {
  PROFILE_DEFINITIONS,
  PROFILE_NAMES,
  getProfileDefinition,
  isProfileName,
} from "../src/profiles";
import { describeValue, thrown } from "./helpers";

/** These values are the documented defaults. Changing a preset must be a deliberate decision. */
const EXPECTED = {
  fast: { latency: 0, jitter: 0, failureRate: 0, allowOverrides: true },
  "slow-3g": { latency: 2000, jitter: 0, failureRate: 0, allowOverrides: true },
  unstable: { latency: 800, jitter: 600, failureRate: 0.3, allowOverrides: true },
  "high-latency": { latency: 3000, jitter: 0, failureRate: 0, allowOverrides: true },
  offline: { latency: 0, jitter: 0, failureRate: 1, allowOverrides: false },
} as const satisfies Record<NetworkProfile, object>;

const ALL: readonly NetworkProfile[] = ["fast", "slow-3g", "unstable", "high-latency", "offline"];

describe("built-in profiles", () => {
  it("exposes exactly the five supported profiles", () => {
    expect([...PROFILE_NAMES].sort()).toEqual([...ALL].sort());
    expect(Object.keys(PROFILE_DEFINITIONS).sort()).toEqual([...ALL].sort());
  });

  for (const name of ALL) {
    describe(name, () => {
      const definition = getProfileDefinition(name);

      it("has valid, in-range defaults", () => {
        expect(Number.isFinite(definition.latency)).toBe(true);
        expect(definition.latency).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(definition.jitter)).toBe(true);
        expect(definition.jitter).toBeGreaterThanOrEqual(0);
        expect(definition.failureRate).toBeGreaterThanOrEqual(0);
        expect(definition.failureRate).toBeLessThanOrEqual(1);
        expect(definition.description.length).toBeGreaterThan(10);
        expect(typeof definition.allowOverrides).toBe("boolean");
      });

      it("matches the documented defaults", () => {
        expect(definition).toMatchObject(EXPECTED[name]);
      });

      it("is deeply frozen and cannot be mutated", () => {
        expect(Object.isFrozen(definition)).toBe(true);
        expect(Reflect.set(definition, "latency", 1)).toBe(false);
        expect(Reflect.set(definition, "failureRate", 1)).toBe(false);
        expect(Reflect.deleteProperty(definition, "latency")).toBe(false);
        expect(definition).toMatchObject(EXPECTED[name]);
      });

      it("can be selected when creating an instance", () => {
        const chaos = createNetChaos({ profile: name });
        expect(chaos.profile).toBe(name);
        expect(chaos.getConfig()).toEqual({
          profile: name,
          latency: EXPECTED[name].latency,
          failureRate: EXPECTED[name].failureRate,
        });
      });

      it("can be switched to at runtime without creating a new instance", () => {
        const chaos = createNetChaos({ profile: name === "fast" ? "offline" : "fast" });
        const sameInstance = chaos;
        chaos.setProfile(name);
        expect(chaos).toBe(sameInstance);
        expect(chaos.profile).toBe(name);
      });
    });
  }

  it("keeps the preset table itself frozen", () => {
    expect(Object.isFrozen(PROFILE_DEFINITIONS)).toBe(true);
    expect(Reflect.set(PROFILE_DEFINITIONS, "fast", {})).toBe(false);
    expect(Reflect.set(PROFILE_DEFINITIONS, "custom", {})).toBe(false);
    expect(PROFILE_NAMES).toHaveLength(5);
    expect(Object.isFrozen(PROFILE_NAMES)).toBe(true);
  });

  it("returns the same shared frozen definition on every lookup (no copies to mutate)", () => {
    expect(getProfileDefinition("unstable")).toBe(getProfileDefinition("unstable"));
    expect(getProfileDefinition("unstable")).toBe(PROFILE_DEFINITIONS.unstable);
  });
});

describe("profile behaviour contracts", () => {
  it("fast adds no latency and no failures", () => {
    expect(PROFILE_DEFINITIONS.fast).toMatchObject({ latency: 0, jitter: 0, failureRate: 0 });
  });

  it("slow-3g adds significant latency and no failures by default", () => {
    expect(PROFILE_DEFINITIONS["slow-3g"].latency).toBeGreaterThanOrEqual(1000);
    expect(PROFILE_DEFINITIONS["slow-3g"].failureRate).toBe(0);
  });

  it("unstable has variable latency and intermittent (neither 0 nor 1) failures", () => {
    expect(PROFILE_DEFINITIONS.unstable.jitter).toBeGreaterThan(0);
    expect(PROFILE_DEFINITIONS.unstable.failureRate).toBeGreaterThan(0);
    expect(PROFILE_DEFINITIONS.unstable.failureRate).toBeLessThan(1);
  });

  it("high-latency is at least as slow as slow-3g, has no jitter and no failures", () => {
    expect(PROFILE_DEFINITIONS["high-latency"].latency).toBeGreaterThanOrEqual(
      PROFILE_DEFINITIONS["slow-3g"].latency,
    );
    expect(PROFILE_DEFINITIONS["high-latency"].jitter).toBe(0);
    expect(PROFILE_DEFINITIONS["high-latency"].failureRate).toBe(0);
  });

  it("only unstable has jitter", () => {
    const withJitter = ALL.filter((name) => PROFILE_DEFINITIONS[name].jitter > 0);
    expect(withJitter).toEqual(["unstable"]);
  });

  it("only offline refuses overrides, and it always fails", () => {
    const locked = ALL.filter((name) => !PROFILE_DEFINITIONS[name].allowOverrides);
    expect(locked).toEqual(["offline"]);
    expect(PROFILE_DEFINITIONS.offline.failureRate).toBe(1);
  });

  it("the public effective config never exposes the internal jitter", () => {
    for (const name of ALL) {
      expect(Object.keys(createNetChaos({ profile: name }).getConfig()).sort()).toEqual([
        "failureRate",
        "latency",
        "profile",
      ]);
    }
  });
});

describe("profile name validation", () => {
  const invalid: unknown[] = [
    "nope",
    "",
    "FAST",
    "Slow-3G",
    "slow3g",
    " fast",
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    undefined,
    null,
    5,
    true,
    {},
    [],
    ["fast"],
  ];

  for (const value of invalid) {
    it(`isProfileName rejects ${describeValue(value)}`, () => {
      expect(isProfileName(value)).toBe(false);
    });
  }

  for (const name of ALL) {
    it(`isProfileName accepts "${name}"`, () => {
      expect(isProfileName(name)).toBe(true);
    });
  }

  it("rejects an unknown profile at creation with a helpful message listing valid names", () => {
    const error = thrown(() => createNetChaos({ profile: "wifi" as NetworkProfile }));
    expect(error).toBeInstanceOf(NetChaosConfigError);
    expect(error).toMatchObject({ code: "NETCHAOS_INVALID_CONFIG" });
    const message = (error as Error).message;
    expect(message).toContain('"wifi"');
    for (const name of ALL) expect(message).toContain(name);
  });

  it("rejects an unknown profile in setProfile and keeps the active profile", () => {
    const chaos = createNetChaos({ profile: "unstable" });
    for (const value of ["wifi", "", undefined, null, 5, {}]) {
      const error = thrown(() => {
        chaos.setProfile(value as NetworkProfile);
      });
      expect(error).toBeInstanceOf(NetChaosConfigError);
      expect(chaos.profile).toBe("unstable");
    }
  });
});

describe("shared preset safety", () => {
  it("instance activity (overrides, switching, clearing) never mutates the presets", () => {
    const before = JSON.stringify(PROFILE_DEFINITIONS);
    const chaos = new NetChaos({ profile: "slow-3g", latency: 1, failureRate: 0.9 });
    for (const name of ALL) chaos.setProfile(name);
    chaos.clearOverrides();
    createNetChaos({ profile: "unstable", latency: 5 });
    expect(JSON.stringify(PROFILE_DEFINITIONS)).toBe(before);
  });
});
