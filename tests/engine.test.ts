import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetChaosConfigError, SimulatedNetworkError } from "../src";
import { EMPTY_OVERRIDES, resolveConfig, type SimulationConfig } from "../src/core/config";
import { runSimulation } from "../src/simulation/engine";
import { sequence, settle, trackSignal } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const config = (profile: Parameters<typeof resolveConfig>[0], overrides = EMPTY_OVERRIDES) =>
  resolveConfig(profile, overrides);

function run(
  simulation: SimulationConfig,
  options: { signal?: AbortSignal | null; random?: () => number; response?: Response } = {},
) {
  const response = options.response ?? new Response("ok");
  const forward = vi.fn(() => Promise.resolve(response));
  const random =
    options.random ??
    (() => {
      throw new Error("randomness must not be consumed");
    });
  const outcome = settle(runSimulation({ config: simulation, signal: options.signal, random, forward }));
  return { forward, outcome, response };
}

describe("runSimulation (execution sequence)", () => {
  it("forwards a surviving request and returns the original Response object", async () => {
    const { forward, outcome, response } = run(config("fast"));
    const result = await outcome;
    expect(forward).toHaveBeenCalledTimes(1);
    expect(result.status === "fulfilled" && result.value).toBe(response);
  });

  it("starts the underlying request synchronously when there is no latency", () => {
    const { forward } = run(config("fast"));
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("does not read, clone or consume the response body", async () => {
    const response = new Response("payload");
    const { outcome } = run(config("fast"), { response });
    await outcome;
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("payload");
  });

  it("simulated failure rejects with SimulatedNetworkError carrying the profile, never forwarding", async () => {
    const { forward, outcome } = run(config("fast", { failureRate: 1 }));
    const result = await outcome;
    expect(result.status === "rejected" && result.reason).toBeInstanceOf(SimulatedNetworkError);
    expect(result.status === "rejected" && result.reason).toMatchObject({ profile: "fast" });
    expect(forward).not.toHaveBeenCalled();
  });

  it("offline fails immediately: no timers, no randomness, nothing forwarded", async () => {
    const { forward, outcome } = run(config("offline"));
    const result = await outcome;
    expect(result.status).toBe("rejected");
    expect(vi.getTimerCount()).toBe(0);
    expect(forward).not.toHaveBeenCalled();
  });

  it("a rejected simulated failure is never an HTTP response", async () => {
    const result = await run(config("offline")).outcome;
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.reason).not.toBeInstanceOf(Response);
  });

  it("propagates a native fetch rejection unchanged and does not retry", async () => {
    const boom = new TypeError("native failure");
    const forward = vi.fn(() => Promise.reject(boom));
    const result = await settle(
      runSimulation({ config: config("fast"), signal: undefined, random: () => 0, forward }),
    );
    expect(result.status === "rejected" && result.reason).toBe(boom);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("turns a synchronous throw from forward into a rejection", async () => {
    const boom = new Error("sync");
    const result = await settle(
      runSimulation({
        config: config("fast"),
        signal: undefined,
        random: () => 0,
        forward: () => {
          throw boom;
        },
      }),
    );
    expect(result.status === "rejected" && result.reason).toBe(boom);
  });
});

describe("runSimulation ordering", () => {
  it("applies latency first, then rolls for failure, then forwards", async () => {
    const { forward, outcome } = run(config("slow-3g", { failureRate: 0.5 }), { random: sequence([0.9]) });
    await vi.advanceTimersByTimeAsync(1999);
    expect(forward).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(forward).toHaveBeenCalledTimes(1);
    expect((await outcome).status).toBe("fulfilled");
  });

  it("draws the jitter value first and the failure value second", async () => {
    // jitter draw 1 => 1400ms; failure draw 0.2 < 0.3 => fail.
    // (If the draws were swapped: jitter 0.2 => 440ms and failure draw 1 => survive.)
    const { forward, outcome } = run(config("unstable"), { random: sequence([1, 0.2]) });
    await vi.advanceTimersByTimeAsync(1399);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await outcome;
    expect(result.status).toBe("rejected");
    expect(forward).not.toHaveBeenCalled();
  });

  it("checks for a prior abort BEFORE any latency or randomness", async () => {
    const controller = new AbortController();
    controller.abort();
    const { forward, outcome } = run(config("unstable"), { signal: controller.signal });
    const result = await outcome; // random would throw if consumed
    expect((result.status === "rejected" ? result.reason : undefined) as Error).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
    expect(forward).not.toHaveBeenCalled();
  });

  it("an abort during the delay stops the request before the failure roll and before forwarding", async () => {
    const controller = new AbortController();
    const random = sequence([0.5, 0.1]);
    const { forward, outcome } = run(config("unstable"), { signal: controller.signal, random });
    await vi.advanceTimersByTimeAsync(300);
    controller.abort();
    const result = await outcome;
    expect(result.status === "rejected" && (result.reason as Error).name).toBe("AbortError");
    expect(random.drawn()).toBe(1);
    expect(forward).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not forward a request whose signal became aborted at the instant the delay finished", async () => {
    // The signal flips to aborted while the engine cleans up after the timer fires, i.e. in the
    // window between "timer elapsed" and "engine continues". A final check must catch this.
    const state = { aborted: false };
    const signal = {
      get aborted() {
        return state.aborted;
      },
      reason: undefined,
      addEventListener: () => undefined,
      removeEventListener: () => {
        state.aborted = true;
      },
    } as unknown as AbortSignal;
    const { forward, outcome } = run(config("fast", { latency: 100 }), { signal });
    await vi.advanceTimersByTimeAsync(100);
    const result = await outcome;
    expect((result.status === "rejected" ? result.reason : undefined) as Error).toMatchObject({ name: "AbortError" });
    expect(forward).not.toHaveBeenCalled();
  });

  it("abort wins over a simulated failure that would have happened later", async () => {
    const controller = new AbortController();
    const { outcome } = run(config("fast", { latency: 1000, failureRate: 1 }), { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    const result = await outcome;
    expect(result.status === "rejected" && result.reason).not.toBeInstanceOf(SimulatedNetworkError);
  });

  it("cleans up its abort listener whichever way the request ends", async () => {
    for (const simulation of [config("fast", { latency: 10 }), config("fast", { latency: 10, failureRate: 1 })]) {
      const { signal, counts } = trackSignal();
      const { outcome } = run(simulation, { signal });
      await vi.advanceTimersByTimeAsync(10);
      await outcome;
      expect(counts).toEqual({ added: 1, removed: 1 });
    }
  });

  it("does not add any listener or timer when latency is zero", async () => {
    const { signal, counts } = trackSignal();
    await run(config("fast"), { signal }).outcome;
    expect(counts.added).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with NetChaosConfigError if the random source returns garbage", async () => {
    const result = await run(config("fast", { failureRate: 0.5 }), { random: () => Number.NaN }).outcome;
    expect(result.status === "rejected" && result.reason).toBeInstanceOf(NetChaosConfigError);
  });
});
