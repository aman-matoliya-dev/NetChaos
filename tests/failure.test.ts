import { afterEach, describe, expect, it, vi } from "vitest";
import { NetChaosConfigError, SimulatedNetworkError, createNetChaos } from "../src";
import { shouldFail } from "../src/simulation/failure";
import { createMockFetch, mulberry32, sequence, settle, startWithoutThrowing } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

const neverDraw = () => {
  throw new Error("randomness must not be consumed here");
};

describe("shouldFail (probability math)", () => {
  it("rate 0 never fails and never consumes randomness", () => {
    for (let i = 0; i < 1000; i++) {
      expect(shouldFail(0, neverDraw)).toBe(false);
    }
  });

  it("rate 1 always fails and never consumes randomness", () => {
    for (let i = 0; i < 1000; i++) {
      expect(shouldFail(1, neverDraw)).toBe(true);
    }
  });

  it("treats rates at or below 0 / NaN as never failing and above 1 as always failing", () => {
    expect(shouldFail(-1, neverDraw)).toBe(false);
    expect(shouldFail(Number.NaN, neverDraw)).toBe(false);
    expect(shouldFail(2, neverDraw)).toBe(true);
  });

  it("fails only when the draw is strictly below the rate (deterministic boundaries)", () => {
    expect(shouldFail(0.3, () => 0)).toBe(true);
    expect(shouldFail(0.3, () => 0.2999999)).toBe(true);
    expect(shouldFail(0.3, () => 0.3)).toBe(false);
    expect(shouldFail(0.3, () => 0.3000001)).toBe(false);
    expect(shouldFail(0.3, () => 0.9999999)).toBe(false);
  });

  it("draws exactly once per decision", () => {
    const random = sequence([0.1, 0.9, 0.5]);

    expect(shouldFail(0.5, random)).toBe(true);
    expect(shouldFail(0.5, random)).toBe(false);
    expect(shouldFail(0.5, random)).toBe(false);
    expect(random.drawn()).toBe(3);
  });

  it("is exactly correct over an evenly spaced grid of draws (no sampling noise)", () => {
    const grid = 10000;

    for (const rate of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      let failures = 0;

      for (let i = 0; i < grid; i++) {
        if (shouldFail(rate, () => i / grid)) failures++;
      }

      expect(failures).toBe(rate * grid);
    }
  });

  it("matches the configured probability for pseudo-random draws (seeded, within 5 sigma)", () => {
    const samples = 100_000;

    for (const rate of [0.01, 0.1, 0.3, 0.5, 0.7, 0.99]) {
      const random = mulberry32(12345);
      let failures = 0;

      for (let i = 0; i < samples; i++) {
        if (shouldFail(rate, random)) failures++;
      }

      const sigma = Math.sqrt((rate * (1 - rate)) / samples);
      expect(Math.abs(failures / samples - rate)).toBeLessThan(5 * sigma);
    }
  });

  it("rejects an invalid random source value", () => {
    expect(() => shouldFail(0.5, () => Number.NaN)).toThrow(NetChaosConfigError);
    expect(() => shouldFail(0.5, () => 1)).toThrow(NetChaosConfigError);
    expect(() => shouldFail(0.5, () => 2)).toThrow(NetChaosConfigError);
  });
});

describe("failures through chaos.fetch", () => {
  it("failureRate 0 never intentionally fails", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ failureRate: 0, fetch: fetchMock });

    for (let i = 0; i < 500; i++) {
      expect((await settle(chaos.fetch("/x"))).status).toBe("fulfilled");
    }

    expect(fetchMock).toHaveBeenCalledTimes(500);
  });

  it("failureRate 1 always fails and never reaches fetch", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ failureRate: 1, fetch: fetchMock });

    for (let i = 0; i < 500; i++) {
      const result = await settle(chaos.fetch("/x"));

      expect(result.status === "rejected" && result.reason).toBeInstanceOf(SimulatedNetworkError);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("evaluates every request independently, using one draw each (deterministic)", async () => {
    const fetchMock = createMockFetch();
    const random = sequence([0.1, 0.5, 0.2, 0.3, 0.29]);
    const chaos = createNetChaos({ failureRate: 0.3, fetch: fetchMock, random });
    const statuses: string[] = [];

    for (const path of ["/1", "/2", "/3", "/4", "/5"]) {
      statuses.push((await settle(chaos.fetch(path))).status);
    }

    expect(statuses).toEqual(["rejected", "fulfilled", "rejected", "fulfilled", "rejected"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(random.drawn()).toBe(5);
  });

  it("concurrent requests are decided independently, in call order", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({
      failureRate: 0.5,
      fetch: fetchMock,
      random: sequence([0.9, 0.1, 0.9, 0.1]),
    });

    const results = await Promise.all(
      ["/a", "/b", "/c", "/d"].map((path) => settle(chaos.fetch(path))),
    );

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "rejected",
    ]);
  });

  it("an intermediate rate is probabilistic (seeded 20,000-request run lands within 5 sigma)", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({
      failureRate: 0.3,
      fetch: fetchMock,
      random: mulberry32(2024),
    });

    const total = 20_000;
    const results = await Promise.all(
      Array.from({ length: total }, () => settle(chaos.fetch("/x"))),
    );

    const failures = results.filter((result) => result.status === "rejected").length;
    const sigma = Math.sqrt((0.3 * 0.7) / total);

    expect(Math.abs(failures / total - 0.3)).toBeLessThan(5 * sigma);
    expect(fetchMock).toHaveBeenCalledTimes(total - failures);
  });

  it("uses Math.random by default, once per request", async () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.1);
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ failureRate: 0.3, fetch: fetchMock });

    expect((await settle(chaos.fetch("/x"))).status).toBe("rejected");
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockReturnValue(0.5);

    expect((await settle(chaos.fetch("/x"))).status).toBe("fulfilled");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not consume randomness for deterministic profiles", async () => {
    const random = sequence([]);

    for (const profile of ["fast", "high-latency", "offline"] as const) {
      const chaos = createNetChaos({
        profile,
        latency: 0,
        fetch: createMockFetch(),
        random,
      });

      await settle(chaos.fetch("/x"));
    }

    expect(random.drawn()).toBe(0);
  });

  it("randomness does not leak between instances", async () => {
    const randomA = sequence([0.1, 0.1]);
    const randomB = sequence([0.9, 0.9, 0.9]);

    const a = createNetChaos({
      failureRate: 0.5,
      fetch: createMockFetch(),
      random: randomA,
    });

    const b = createNetChaos({
      failureRate: 0.5,
      fetch: createMockFetch(),
      random: randomB,
    });

    expect((await settle(a.fetch("/x"))).status).toBe("rejected");
    expect((await settle(b.fetch("/x"))).status).toBe("fulfilled");
    expect((await settle(b.fetch("/x"))).status).toBe("fulfilled");
    expect((await settle(a.fetch("/x"))).status).toBe("rejected");

    expect(randomA.drawn()).toBe(2);
    expect(randomB.drawn()).toBe(2);
  });

  it("rejects (not throws) with NetChaosConfigError if a custom random source misbehaves", async () => {
    const chaos = createNetChaos({
      failureRate: 0.5,
      random: () => 7,
      fetch: createMockFetch(),
    });

    const promise = startWithoutThrowing(() => chaos.fetch("/x"));
    const result = await settle(promise);

    expect(result.status === "rejected" && result.reason).toBeInstanceOf(NetChaosConfigError);
  });

  it("the unstable profile draws jitter first, then the failure roll (30% default)", async () => {
    const fetchMock = createMockFetch();
    vi.useFakeTimers();

    try {
      // Request 1: jitter draw 0.5 => 800ms, failure draw 0.29 < 0.3 => fails.
      // Request 2: jitter draw 0.5 => 800ms, failure draw 0.31 >= 0.3 => survives.
      const random = sequence([0.5, 0.29, 0.5, 0.31]);
      const chaos = createNetChaos({
        profile: "unstable",
        fetch: fetchMock,
        random,
      });

      const first = settle(chaos.fetch("/1"));
      await vi.advanceTimersByTimeAsync(800);

      expect((await first).status).toBe("rejected");
      expect(random.drawn()).toBe(2);

      const second = settle(chaos.fetch("/2"));
      await vi.advanceTimersByTimeAsync(800);

      expect((await second).status).toBe("fulfilled");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(random.drawn()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
