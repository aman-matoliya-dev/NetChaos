import { describe, expect, it } from "vitest";
import {
  NetChaosConfigError,
  NetChaosError,
  SimulatedNetworkError,
  type NetChaosErrorCode,
  type NetworkProfile,
} from "../src";

describe("NetChaosError", () => {
  it("is an Error with a name, message, code and stack", () => {
    const error = new NetChaosError("boom", "NETCHAOS_INVALID_CONFIG");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NetChaosError");
    expect(error.message).toBe("boom");
    expect(error.code).toBe("NETCHAOS_INVALID_CONFIG");
    expect(typeof error.stack).toBe("string");
  });
});

describe("NetChaosConfigError", () => {
  it("extends NetChaosError and carries the stable invalid-config code", () => {
    const error = new NetChaosConfigError("bad value");
    expect(error).toBeInstanceOf(NetChaosError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.name).toBe("NetChaosConfigError");
    expect(error.code).toBe("NETCHAOS_INVALID_CONFIG");
    expect(error.message).toBe("bad value");
  });
});

describe("SimulatedNetworkError", () => {
  const profiles: NetworkProfile[] = ["fast", "slow-3g", "unstable", "high-latency", "offline"];

  for (const profile of profiles) {
    it(`is a TypeError (like a real fetch network failure) for profile ${profile}`, () => {
      const error = new SimulatedNetworkError(profile);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("SimulatedNetworkError");
      expect(error.code).toBe("NETCHAOS_SIMULATED_FAILURE");
      expect(error.profile).toBe(profile);
      expect(error.message).toContain("simulated");
      expect(error.message).toContain(profile);
      expect(typeof error.stack).toBe("string");
    });
  }

  it("is deliberately not a NetChaosError (it must stay a TypeError); use `code` to detect it", () => {
    const error = new SimulatedNetworkError("offline");
    expect(error).not.toBeInstanceOf(NetChaosError);
    expect(error.code satisfies NetChaosErrorCode).toBe("NETCHAOS_SIMULATED_FAILURE");
  });

  it("can be handled by generic network-error code that checks instanceof TypeError", () => {
    const classify = (error: unknown): string =>
      error instanceof TypeError ? "network" : "other";
    expect(classify(new SimulatedNetworkError("offline"))).toBe("network");
    expect(classify(new NetChaosConfigError("x"))).toBe("other");
  });

  it("has exactly name, code and profile as own properties: no request data can be attached", () => {
    const keys = Object.keys(new SimulatedNetworkError("unstable")).sort();
    expect(keys).toEqual(["code", "name", "profile"]);
  });
});
