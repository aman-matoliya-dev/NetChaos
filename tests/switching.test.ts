import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimulatedNetworkError, createNetChaos } from "../src";
import { callArgs, createMockFetch, returnValueOf, settle } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("runtime profile switching", () => {
  it("setProfile() changes the active profile for future requests", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "fast", fetch: fetchMock });
    expect((await settle(chaos.fetch("/1"))).status).toBe("fulfilled");
    chaos.setProfile("offline");
    expect(chaos.profile).toBe("offline");
    expect((await settle(chaos.fetch("/2"))).status).toBe("rejected");
    chaos.setProfile("fast");
    expect((await settle(chaos.fetch("/3"))).status).toBe("fulfilled");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns nothing and does not create a new instance", () => {
    const chaos = createNetChaos();
    const fetchBefore = chaos.fetch;
    expect(returnValueOf(chaos.setProfile.bind(chaos, "unstable"))).toBeUndefined();
    expect(chaos.fetch).toBe(fetchBefore);
  });
});

describe("per-request configuration snapshots", () => {
  it("the specification example: first request keeps slow-3g, second request is offline", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "slow-3g", fetch: fetchMock });

    const firstRequest = settle(chaos.fetch("/api/first"));
    chaos.setProfile("offline");
    const secondRequest = settle(chaos.fetch("/api/second"));

    const second = await secondRequest;
    expect(second.status === "rejected" && second.reason).toBeInstanceOf(SimulatedNetworkError);
    expect(second.status === "rejected" && second.reason).toMatchObject({ profile: "offline" });
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await firstRequest).status).toBe("fulfilled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callArgs(fetchMock)[0]).toBe("/api/first");
  });

  it("an in-flight request that will fail still fails after switching to fast", async () => {
    const chaos = createNetChaos({ profile: "slow-3g", latency: 500, failureRate: 1, fetch: createMockFetch() });
    const inFlight = settle(chaos.fetch("/x"));
    chaos.setProfile("fast");
    chaos.clearOverrides();
    await vi.advanceTimersByTimeAsync(500);
    const result = await inFlight;
    expect(result.status === "rejected" && result.reason).toMatchObject({ profile: "slow-3g" });
  });

  it("an in-flight request that will succeed is not cancelled by switching to offline", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "high-latency", fetch: fetchMock });
    const inFlight = settle(chaos.fetch("/x"));
    await vi.advanceTimersByTimeAsync(1000);
    chaos.setProfile("offline");
    await vi.advanceTimersByTimeAsync(2000);
    expect((await inFlight).status).toBe("fulfilled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clearOverrides() does not change the latency of a request already in progress", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ latency: 1000, fetch: fetchMock });
    const inFlight = settle(chaos.fetch("/x"));
    chaos.clearOverrides();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await inFlight).status).toBe("fulfilled");
  });

  it("a request started while offline is not rescued by switching to fast", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "offline", fetch: fetchMock });
    const inFlight = settle(chaos.fetch("/x"));
    chaos.setProfile("fast");
    expect((await inFlight).status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the snapshot is taken synchronously when fetch() is called, not when it is awaited", async () => {
    const chaos = createNetChaos({ profile: "offline", fetch: createMockFetch() });
    const offlineRequest = chaos.fetch("/x");
    chaos.setProfile("fast");
    const result = await settle(offlineRequest);
    expect(result.status).toBe("rejected");
  });

  it("concurrent requests across several profiles each keep their own configuration", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "slow-3g", fetch: fetchMock });
    const slow = settle(chaos.fetch("/slow"));
    chaos.setProfile("high-latency");
    const high = settle(chaos.fetch("/high"));
    chaos.setProfile("fast");
    const fast = settle(chaos.fetch("/fast"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callArgs(fetchMock, 0)[0]).toBe("/fast");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callArgs(fetchMock, 1)[0]).toBe("/slow");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callArgs(fetchMock, 2)[0]).toBe("/high");
    expect((await Promise.all([slow, high, fast])).map((r) => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
  });

  it("many rapid profile switches never disturb a request in flight", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "slow-3g", fetch: fetchMock });
    const inFlight = settle(chaos.fetch("/x"));
    const profiles = ["offline", "unstable", "fast", "high-latency"] as const;
    for (let i = 0; i < 100; i++) chaos.setProfile(profiles[i % profiles.length] ?? "fast");
    await vi.advanceTimersByTimeAsync(2000);
    expect((await inFlight).status).toBe("fulfilled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an invalid setProfile() call neither switches the profile nor disturbs in-flight requests", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "slow-3g", fetch: fetchMock });
    const inFlight = settle(chaos.fetch("/x"));
    expect(() => {
      chaos.setProfile("bogus" as never);
    }).toThrow();
    expect(chaos.profile).toBe("slow-3g");
    await vi.advanceTimersByTimeAsync(2000);
    expect((await inFlight).status).toBe("fulfilled");
  });

  it("captures overrides at call time as part of the snapshot", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "slow-3g", latency: 100, fetch: fetchMock });
    const withOverride = settle(chaos.fetch("/with"));
    chaos.clearOverrides();
    const withoutOverride = settle(chaos.fetch("/without"));
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callArgs(fetchMock)[0]).toBe("/with");
    await vi.advanceTimersByTimeAsync(1900);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await Promise.all([withOverride, withoutOverride]);
  });

  it("switching one instance never affects another instance's in-flight or future requests", async () => {
    const mockA = createMockFetch();
    const mockB = createMockFetch();
    const a = createNetChaos({ profile: "slow-3g", fetch: mockA });
    const b = createNetChaos({ profile: "slow-3g", fetch: mockB });
    const inFlightB = settle(b.fetch("/b"));
    a.setProfile("offline");
    expect((await settle(a.fetch("/a"))).status).toBe("rejected");
    await vi.advanceTimersByTimeAsync(2000);
    expect((await inFlightB).status).toBe("fulfilled");
    expect(mockA).not.toHaveBeenCalled();
    expect(mockB).toHaveBeenCalledTimes(1);
  });
});
