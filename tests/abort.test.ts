import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimulatedNetworkError, createNetChaos } from "../src";
import { resolveSignal } from "../src/core/fetch-wrapper";
import { createAbortError, throwIfAborted } from "../src/simulation/abort";
import {
  callArgs,
  createAbortAwareFetch,
  createMockFetch,
  settle,
  startWithoutThrowing,
  thrown,
  trackSignal,
} from "./helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const reasonOf = (result: Awaited<ReturnType<typeof settle>>): unknown =>
  result.status === "rejected" ? result.reason : undefined;
const request = (signal?: AbortSignal | null) =>
  new Request("https://example.test/resource", signal === undefined ? {} : { signal });

describe("cancellation during artificial latency", () => {
  it("stops waiting as soon as the signal aborts and never forwards the request", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "slow-3g", latency: 5000, fetch: fetchMock });
    const controller = new AbortController();
    const outcome = settle(chaos.fetch("/x", { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    const reason = reasonOf(await outcome);
    expect(reason).toBeInstanceOf(DOMException);
    expect(reason).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves no pending timer and no listener behind after an abort", async () => {
    const chaos = createNetChaos({ latency: 5000, fetch: createMockFetch() });
    const { controller, signal, counts } = trackSignal();
    const outcome = settle(chaos.fetch("/x", { signal }));
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
    expect(counts).toEqual({ added: 1, removed: 1 });
  });

  it("removes its listener after normal completion too", async () => {
    const chaos = createNetChaos({ latency: 100, fetch: createMockFetch() });
    const { signal, counts } = trackSignal();
    const outcome = settle(chaos.fetch("/x", { signal }));
    await vi.advanceTimersByTimeAsync(100);
    expect((await outcome).status).toBe("fulfilled");
    expect(counts).toEqual({ added: 1, removed: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accumulate listeners when one signal is reused across many requests", async () => {
    const chaos = createNetChaos({ latency: 10, fetch: createMockFetch() });
    const { signal, counts } = trackSignal();
    for (let i = 0; i < 50; i++) {
      const outcome = settle(chaos.fetch("/x", { signal }));
      await vi.advanceTimersByTimeAsync(10);
      await outcome;
    }
    expect(counts).toEqual({ added: 50, removed: 50 });
  });

  it("one shared signal cancels every request waiting on it, and cleans every listener", async () => {
    const chaos = createNetChaos({ latency: 5000, fetch: createMockFetch() });
    const { controller, signal, counts } = trackSignal();
    const outcomes = [1, 2, 3].map((n) => settle(chaos.fetch(`/x${String(n)}`, { signal })));
    controller.abort();
    const results = await Promise.all(outcomes);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(counts).toEqual({ added: 3, removed: 3 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborting one request does not affect others with a different signal", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ latency: 1000, fetch: fetchMock });
    const first = new AbortController();
    const second = new AbortController();
    const a = settle(chaos.fetch("/a", { signal: first.signal }));
    const b = settle(chaos.fetch("/b", { signal: second.signal }));
    first.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await a).status).toBe("rejected");
    expect((await b).status).toBe("fulfilled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callArgs(fetchMock)[0]).toBe("/b");
  });

  it("an abort mid-delay beats the simulated failure that would have followed", async () => {
    const chaos = createNetChaos({ latency: 1000, failureRate: 1, fetch: createMockFetch() });
    const controller = new AbortController();
    const outcome = settle(chaos.fetch("/x", { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(400);
    controller.abort();
    const reason = reasonOf(await outcome);
    expect(reason).not.toBeInstanceOf(SimulatedNetworkError);
    expect(reason).toMatchObject({ name: "AbortError" });
  });

  it("an abort after the request was forwarded is handled natively (the signal is passed through)", async () => {
    const chaos = createNetChaos({ latency: 100, fetch: createAbortAwareFetch() });
    const controller = new AbortController();
    const customReason = new Error("user cancelled");
    const outcome = settle(chaos.fetch("/x", { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(customReason);
    expect(reasonOf(await outcome)).toBe(customReason);
  });

  it("forwards the original signal object to the underlying fetch untouched", async () => {
    const fetchMock = createMockFetch();
    const controller = new AbortController();
    const init: RequestInit = { signal: controller.signal };
    await createNetChaos({ fetch: fetchMock }).fetch("/x", init);
    expect(callArgs(fetchMock)[1]).toBe(init);
    expect(callArgs(fetchMock)[1]?.signal).toBe(controller.signal);
  });
});

describe("already-aborted requests", () => {
  it("rejects without forwarding, creating a timer, or adding a listener (init.signal)", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ latency: 5000, fetch: fetchMock });
    const controller = new AbortController();
    controller.abort();
    const { signal, counts } = trackSignal(controller);
    const result = await settle(chaos.fetch("/x", { signal }));
    expect(reasonOf(result)).toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(counts.added).toBe(0);
  });

  it("honours an already-aborted Request signal", async () => {
    const fetchMock = createMockFetch();
    const controller = new AbortController();
    controller.abort();
    const result = await settle(
      createNetChaos({ fetch: fetchMock }).fetch(request(controller.signal)),
    );
    expect(reasonOf(result)).toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("even the fast profile (no latency) refuses to forward an aborted request", async () => {
    const fetchMock = createMockFetch();
    const result = await settle(
      createNetChaos({ fetch: fetchMock }).fetch("/x", { signal: AbortSignal.abort() }),
    );
    expect(result.status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an aborted request on the offline profile reports AbortError, not a simulated failure", async () => {
    const result = await settle(
      createNetChaos({ profile: "offline", fetch: createMockFetch() }).fetch("/x", {
        signal: AbortSignal.abort(),
      }),
    );
    expect(reasonOf(result)).toMatchObject({ name: "AbortError" });
  });

  it("rejects with the signal's own custom reason (identity preserved)", async () => {
    for (const reason of [new Error("custom"), "a string reason", 7]) {
      const controller = new AbortController();
      controller.abort(reason);
      const result = await settle(
        createNetChaos({ fetch: createMockFetch() }).fetch("/x", { signal: controller.signal }),
      );
      expect(reasonOf(result)).toBe(reason);
    }
  });
});

describe("native signal semantics (Request vs init.signal are NOT merged)", () => {
  it("honours a Request's own signal during latency", async () => {
    const fetchMock = createMockFetch();
    const controller = new AbortController();
    const chaos = createNetChaos({ latency: 5000, fetch: fetchMock });
    const outcome = settle(chaos.fetch(request(controller.signal)));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(reasonOf(await outcome)).toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("init.signal REPLACES the Request's signal: aborted Request + live init proceeds", async () => {
    const fetchMock = createMockFetch();
    const dead = new AbortController();
    dead.abort();
    const live = new AbortController();
    const result = await settle(
      createNetChaos({ fetch: fetchMock }).fetch(request(dead.signal), { signal: live.signal }),
    );
    expect(result.status).toBe("fulfilled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("init.signal REPLACES the Request's signal: live Request + aborted init is cancelled", async () => {
    const fetchMock = createMockFetch();
    const live = new AbortController();
    const dead = new AbortController();
    dead.abort();
    const result = await settle(
      createNetChaos({ fetch: fetchMock }).fetch(request(live.signal), { signal: dead.signal }),
    );
    expect(result.status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborting the Request's signal does NOT cancel a request governed by a different init.signal", async () => {
    const fetchMock = createMockFetch();
    const requestController = new AbortController();
    const initController = new AbortController();
    const chaos = createNetChaos({ latency: 100, fetch: fetchMock });
    const outcome = settle(
      chaos.fetch(request(requestController.signal), { signal: initController.signal }),
    );
    await vi.advanceTimersByTimeAsync(50);
    requestController.abort();
    await vi.advanceTimersByTimeAsync(50);
    expect((await outcome).status).toBe("fulfilled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an explicit init.signal of null removes the Request's signal", async () => {
    const fetchMock = createMockFetch();
    const dead = new AbortController();
    dead.abort();
    const result = await settle(
      createNetChaos({ fetch: fetchMock }).fetch(request(dead.signal), { signal: null }),
    );
    expect(result.status).toBe("fulfilled");
  });

  it("an init.signal of undefined falls back to the Request's signal", async () => {
    const dead = new AbortController();
    dead.abort();
    const fetchMock = createMockFetch();
    const result = await settle(
      createNetChaos({ fetch: fetchMock }).fetch(request(dead.signal), { signal: undefined }),
    );
    expect(result.status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("resolveSignal (unit)", () => {
    const controller = new AbortController();
    const other = new AbortController();

    it("returns undefined when nothing supplies a signal", () => {
      expect(resolveSignal("/x", undefined)).toBeUndefined();
      expect(resolveSignal("/x", {})).toBeUndefined();
      expect(resolveSignal(new URL("https://example.test"), null)).toBeUndefined();
      expect(resolveSignal(request(), undefined)?.aborted).toBe(false);
    });

    it("prefers init.signal, including null, over the Request signal", () => {
      expect(resolveSignal(request(controller.signal), { signal: other.signal })).toBe(
        other.signal,
      );
      expect(resolveSignal(request(controller.signal), { signal: null })).toBeNull();
    });

    it("uses the Request signal when init.signal is undefined or absent", () => {
      const req = request(controller.signal);
      expect(resolveSignal(req, undefined)).toBe(req.signal);
      expect(resolveSignal(req, { signal: undefined })).toBe(req.signal);
    });

    it("rejects values that are not AbortSignal-like with a TypeError", () => {
      for (const bad of [
        {},
        "signal",
        5,
        true,
        { aborted: false },
        { aborted: true, addEventListener: 1 },
      ]) {
        const error = thrown(() => resolveSignal("/x", { signal: bad as unknown as AbortSignal }));
        expect(error).toBeInstanceOf(TypeError);
      }
    });
  });
});

describe("invalid signals", () => {
  for (const bad of [{}, "nope", 5, { aborted: false }]) {
    it(`rejects (never throws synchronously) for signal ${JSON.stringify(bad)}`, async () => {
      const fetchMock = createMockFetch();
      const chaos = createNetChaos({ fetch: fetchMock });
      const promise = startWithoutThrowing(() =>
        chaos.fetch("/x", { signal: bad as unknown as AbortSignal }),
      );
      const result = await settle(promise);
      expect(reasonOf(result)).toBeInstanceOf(TypeError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("accepts a minimal AbortSignal-like object (duck typing) and cleans up its listener", async () => {
    const listeners = new Set<() => void>();
    const fake = {
      aborted: false,
      reason: undefined as unknown,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
    };
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ latency: 100, fetch: fetchMock });
    const first = settle(chaos.fetch("/x", { signal: fake as unknown as AbortSignal }));
    expect(listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).status).toBe("fulfilled");
    expect(listeners.size).toBe(0);

    const second = settle(chaos.fetch("/y", { signal: fake as unknown as AbortSignal }));
    fake.aborted = true;
    for (const listener of [...listeners]) listener();
    expect(reasonOf(await second)).toMatchObject({ name: "AbortError" });
    expect(listeners.size).toBe(0);
  });
});

describe("abort helpers", () => {
  it("createAbortError returns the signal's reason, or a default AbortError DOMException", () => {
    const controller = new AbortController();
    controller.abort("why");
    expect(createAbortError(controller.signal)).toBe("why");
    const fallback = createAbortError();
    expect(fallback).toBeInstanceOf(DOMException);
    expect(fallback).toMatchObject({ name: "AbortError" });
    expect(createAbortError(null)).toMatchObject({ name: "AbortError" });
  });

  it("createAbortError falls back to a plain Error named AbortError where DOMException is missing", () => {
    vi.stubGlobal("DOMException", undefined);
    const error = createAbortError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "AbortError", message: "This operation was aborted" });
  });

  it("throwIfAborted throws only for aborted signals", () => {
    expect(() => {
      throwIfAborted();
    }).not.toThrow();
    expect(() => {
      throwIfAborted(null);
    }).not.toThrow();
    expect(() => {
      throwIfAborted(new AbortController().signal);
    }).not.toThrow();
    const reason = new Error("r");
    const controller = new AbortController();
    controller.abort(reason);
    expect(
      thrown(() => {
        throwIfAborted(controller.signal);
      }),
    ).toBe(reason);
  });
});

describe("timers after mixed outcomes", () => {
  it("leaves no timers pending after completed, failed and aborted requests", async () => {
    const ok = createNetChaos({ latency: 100, fetch: createMockFetch() });
    const failing = createNetChaos({ latency: 100, failureRate: 1, fetch: createMockFetch() });
    const controller = new AbortController();
    const outcomes = [
      settle(ok.fetch("/1")),
      settle(failing.fetch("/2")),
      settle(ok.fetch("/3", { signal: controller.signal })),
    ];
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(outcomes);
    expect(vi.getTimerCount()).toBe(0);
  });
});
