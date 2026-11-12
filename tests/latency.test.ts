import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetChaosConfigError, createNetChaos } from "../src";
import { MAX_LATENCY_MS } from "../src/core/config";
import { computeDelay, waitFor } from "../src/simulation/latency";
import { createMockFetch, sequence, settle, trackSignal } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const neverDraw = () => {
  throw new Error("randomness must not be consumed here");
};

describe("computeDelay (jitter math)", () => {
  it("is 0 for zero, negative or NaN latency, whatever the jitter, without drawing", () => {
    expect(computeDelay(0, 600, neverDraw)).toBe(0);
    expect(computeDelay(-5, 600, neverDraw)).toBe(0);
    expect(computeDelay(Number.NaN, 600, neverDraw)).toBe(0);
  });

  it("is exactly the latency when there is no jitter, without drawing", () => {
    expect(computeDelay(2000, 0, neverDraw)).toBe(2000);
    expect(computeDelay(3000, 0, neverDraw)).toBe(3000);
  });

  it("uses latency +/- jitter at the extremes of the random range (deterministic draws)", () => {
    expect(computeDelay(800, 600, () => 0)).toBe(200);
    expect(computeDelay(800, 600, () => 0.5)).toBe(800);
    expect(computeDelay(800, 600, () => 1)).toBe(1400);
    expect(computeDelay(800, 600, () => 0.25)).toBe(500);
    expect(computeDelay(800, 600, () => 0.75)).toBe(1100);
  });

  it("limits the spread to the latency so the delay is never negative", () => {
    expect(computeDelay(100, 600, () => 0)).toBe(0);
    expect(computeDelay(100, 600, () => 0.5)).toBe(100);
    expect(computeDelay(100, 600, () => 1)).toBe(200);
  });

  it("never returns a negative delay for any latency/jitter/draw combination", () => {
    for (const latency of [0.5, 1, 10, 100, 800, 5000]) {
      for (const jitter of [0, 1, 100, 600, 10000]) {
        for (let i = 0; i <= 100; i++) {
          const delay = computeDelay(latency, jitter, () => i / 100);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(latency + Math.min(jitter, latency));
        }
      }
    }
  });

  it("keeps the configured latency as the mean of a uniform spread of draws", () => {
    const draws = 1001;
    let sum = 0;
    for (let i = 0; i < draws; i++) sum += computeDelay(800, 600, () => i / (draws - 1));
    expect(sum / draws).toBeCloseTo(800, 6);
  });

  it("consumes exactly one draw per delay when jitter applies", () => {
    const random = sequence([0.5]);
    computeDelay(800, 600, random);
    expect(random.drawn()).toBe(1);
  });

  it("caps the delay at the maximum timer value", () => {
    expect(computeDelay(MAX_LATENCY_MS, 600, () => 1)).toBe(MAX_LATENCY_MS);
    expect(computeDelay(MAX_LATENCY_MS, 0, neverDraw)).toBe(MAX_LATENCY_MS);
  });

  it("rejects an invalid random source value", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      expect(() => computeDelay(800, 600, () => bad)).toThrow(NetChaosConfigError);
    }
  });
});

describe("waitFor (abortable delay)", () => {
  it("resolves exactly when the delay elapses, and leaves no timer behind", async () => {
    const done = vi.fn();
    const promise = waitFor(1000).then(done);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledTimes(1);
    await promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves immediately, without a timer, for 0, negative and NaN delays", async () => {
    for (const ms of [0, -1, Number.NaN]) {
      await waitFor(ms);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("stops waiting as soon as the signal aborts, rejecting with an AbortError", async () => {
    const controller = new AbortController();
    const outcome = settle(waitFor(5000, controller.signal));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const result = await outcome;
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.reason).toBeInstanceOf(DOMException);
    expect(result.status === "rejected" && (result.reason as Error).name).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes its abort listener when aborted", async () => {
    const { controller, signal, counts } = trackSignal();
    const outcome = settle(waitFor(5000, signal));
    controller.abort();
    await outcome;
    expect(counts).toEqual({ added: 1, removed: 1 });
  });

  it("removes its abort listener when the delay completes normally", async () => {
    const { signal, counts } = trackSignal();
    const outcome = settle(waitFor(50, signal));
    await vi.advanceTimersByTimeAsync(50);
    expect((await outcome).status).toBe("fulfilled");
    expect(counts).toEqual({ added: 1, removed: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing if the signal aborts after the delay finished", async () => {
    const controller = new AbortController();
    const outcome = settle(waitFor(10, controller.signal));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect((await outcome).status).toBe("fulfilled");
  });

  it("rejects immediately for an already-aborted signal without starting a timer or listener", async () => {
    const controller = new AbortController();
    controller.abort();
    const { signal, counts } = trackSignal(controller);
    const result = await settle(waitFor(5000, signal));
    expect(result.status).toBe("rejected");
    expect(vi.getTimerCount()).toBe(0);
    expect(counts.added).toBe(0);
  });

  it("rejects with the exact custom abort reason", async () => {
    for (const reason of [new Error("stop"), "because", 42]) {
      const controller = new AbortController();
      const outcome = settle(waitFor(5000, controller.signal));
      controller.abort(reason);
      const result = await outcome;
      expect(result.status === "rejected" && result.reason).toBe(reason);
    }
  });

  it("works without any signal (null and undefined)", async () => {
    for (const signal of [undefined, null]) {
      const outcome = settle(waitFor(10, signal));
      await vi.advanceTimersByTimeAsync(10);
      expect((await outcome).status).toBe("fulfilled");
    }
  });
});

describe("latency applied per profile (through chaos.fetch)", () => {
  async function timeUntilForwarded(
    chaos: ReturnType<typeof createNetChaos>,
    fetchMock: ReturnType<typeof createMockFetch>,
    limit: number,
  ): Promise<number> {
    const outcome = settle(chaos.fetch("/x"));
    for (let elapsed = 0; elapsed <= limit; elapsed++) {
      if (fetchMock.mock.calls.length > 0) {
        expect((await outcome).status).toBe("fulfilled");
        return elapsed;
      }
      await vi.advanceTimersByTimeAsync(1);
    }
    throw new Error(`request was not forwarded within ${String(limit)}ms`);
  }

  it("fast: forwards immediately and creates no timers", () => {
    const fetchMock = createMockFetch();
    void settle(createNetChaos({ profile: "fast", fetch: fetchMock }).fetch("/x"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("slow-3g: holds the request for the full 2000ms before it reaches fetch", async () => {
    const fetchMock = createMockFetch();
    const outcome = settle(createNetChaos({ profile: "slow-3g", fetch: fetchMock }).fetch("/x"));
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await outcome).status).toBe("fulfilled");
  });

  it("high-latency: every request is delayed by exactly the same 3000ms", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "high-latency", fetch: fetchMock });
    for (let round = 1; round <= 5; round++) {
      const outcome = settle(chaos.fetch("/x"));
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetchMock).toHaveBeenCalledTimes(round - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(round);
      await outcome;
    }
  });

  it("high-latency is slower than slow-3g", async () => {
    const slowMock = createMockFetch();
    const highMock = createMockFetch();
    const slow = await timeUntilForwarded(
      createNetChaos({ profile: "slow-3g", fetch: slowMock }),
      slowMock,
      5000,
    );
    const high = await timeUntilForwarded(
      createNetChaos({ profile: "high-latency", fetch: highMock }),
      highMock,
      5000,
    );
    expect(slow).toBe(2000);
    expect(high).toBe(3000);
  });

  for (const [draw, expected] of [
    [0, 200],
    [0.5, 800],
    [1, 1400],
  ] as const) {
    it(`unstable: a random draw of ${String(draw)} gives a ${String(expected)}ms delay`, async () => {
      const fetchMock = createMockFetch();
      const random = sequence([draw]);
      const chaos = createNetChaos({
        profile: "unstable",
        failureRate: 0,
        fetch: fetchMock,
        random,
      });
      const outcome = settle(chaos.fetch("/x"));
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await outcome).status).toBe("fulfilled");
      expect(random.drawn()).toBe(1);
    });
  }

  it("unstable: concurrent requests draw their own, different delays", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({
      profile: "unstable",
      failureRate: 0,
      fetch: fetchMock,
      random: sequence([0, 1]),
    });
    const first = settle(chaos.fetch("/first"));
    const second = settle(chaos.fetch("/second"));
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await Promise.all([first, second]);
  });

  it("a custom latency replaces the profile's latency", async () => {
    const fetchMock = createMockFetch();
    const outcome = settle(
      createNetChaos({ profile: "slow-3g", latency: 500, fetch: fetchMock }).fetch("/x"),
    );
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await outcome;
  });

  it("a custom latency also applies on the fast profile", async () => {
    const fetchMock = createMockFetch();
    const outcome = settle(createNetChaos({ latency: 250, fetch: fetchMock }).fetch("/x"));
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await outcome;
  });

  it("a custom latency on unstable becomes the new base and keeps the internal jitter", async () => {
    for (const [draw, expected] of [
      [0, 0],
      [0.5, 100],
      [1, 200],
    ] as const) {
      const fetchMock = createMockFetch();
      const chaos = createNetChaos({
        profile: "unstable",
        latency: 100,
        failureRate: 0,
        fetch: fetchMock,
        random: sequence([draw]),
      });
      const outcome = settle(chaos.fetch("/x"));
      if (expected > 0) {
        await vi.advanceTimersByTimeAsync(expected - 1);
        expect(fetchMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await outcome;
    }
  });

  it("latency 0 override on slow-3g forwards immediately", () => {
    const fetchMock = createMockFetch();
    void settle(createNetChaos({ profile: "slow-3g", latency: 0, fetch: fetchMock }).fetch("/x"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies the latency BEFORE a simulated failure (failure arrives after the delay)", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ latency: 1000, failureRate: 1, fetch: fetchMock });
    let settled = false;
    const outcome = settle(chaos.fetch("/x")).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await outcome).status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves no timers behind after completed and failed requests", async () => {
    const chaos = createNetChaos({ latency: 100, fetch: createMockFetch() });
    const failing = createNetChaos({ latency: 100, failureRate: 1, fetch: createMockFetch() });
    const outcomes = [settle(chaos.fetch("/a")), settle(failing.fetch("/b"))];
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(outcomes);
    expect(vi.getTimerCount()).toBe(0);
  });
});
