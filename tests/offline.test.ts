import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimulatedNetworkError, createNetChaos } from "../src";
import { createMockFetch, settle } from "./helpers";

describe("offline profile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("every request fails and the underlying fetch is NEVER called", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ profile: "offline", fetch: fetchMock });

    for (let i = 0; i < 200; i++) {
      const result = await settle(chaos.fetch(`/api/${String(i)}`));
      expect(result.status).toBe("rejected");
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not consume or lock a Request body when simulation fails", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({
      profile: "offline",
      fetch: fetchMock,
    });

    const payload = JSON.stringify({ message: "keep this body intact" });

    const request = new Request("https://example.test/resource", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: payload,
    });

    const result = await settle(chaos.fetch(request));

    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.reason).toBeInstanceOf(SimulatedNetworkError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(request.body?.locked).toBe(false);

    // The original body must still be readable after the simulated failure.
    expect(await request.text()).toBe(payload);
  });

  it("fails with a TypeError-compatible SimulatedNetworkError, not a fake HTTP response", async () => {
    const chaos = createNetChaos({ profile: "offline", fetch: createMockFetch() });
    const result = await settle(chaos.fetch("/x"));

    expect(result.status).toBe("rejected");

    const error = result.status === "rejected" ? result.reason : undefined;

    expect(error).toBeInstanceOf(SimulatedNetworkError);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Response);
    expect(error).toMatchObject({
      code: "NETCHAOS_SIMULATED_FAILURE",
      name: "SimulatedNetworkError",
      profile: "offline",
    });
  });

  it("fails immediately: no timer is ever created", async () => {
    const chaos = createNetChaos({ profile: "offline", fetch: createMockFetch() });
    const outcome = settle(chaos.fetch("/x"));

    expect(vi.getTimerCount()).toBe(0);
    expect((await outcome).status).toBe("rejected");
  });

  it("ignores custom latency and failureRate overrides (stays absolute)", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({
      profile: "offline",
      latency: 5000,
      failureRate: 0,
      fetch: fetchMock,
    });

    const outcome = settle(chaos.fetch("/x"));

    expect(vi.getTimerCount()).toBe(0);
    expect((await outcome).status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("overrides set earlier are ignored when switching to offline, and apply again afterwards", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({
      profile: "slow-3g",
      latency: 100,
      failureRate: 0,
      fetch: fetchMock,
    });

    chaos.setProfile("offline");
    expect((await settle(chaos.fetch("/offline"))).status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();

    chaos.setProfile("slow-3g");
    const outcome = settle(chaos.fetch("/online"));

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect((await outcome).status).toBe("fulfilled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("works even when no Fetch implementation exists at all", async () => {
    vi.stubGlobal("fetch", undefined);

    try {
      const chaos = createNetChaos({ profile: "offline" });
      const result = await settle(chaos.fetch("/x"));

      expect(result.status === "rejected" && result.reason).toBeInstanceOf(SimulatedNetworkError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the error never contains request details (URL, headers, body)", async () => {
    const chaos = createNetChaos({ profile: "offline", fetch: createMockFetch() });

    const result = await settle(
      chaos.fetch("https://example.test/path?token=SECRET_TOKEN", {
        method: "POST",
        headers: { authorization: "Bearer SECRET_BEARER" },
        body: "SECRET_BODY",
      }),
    );

    const error = (result.status === "rejected" ? result.reason : undefined) as Error;
    const everything = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;

    for (const secret of ["SECRET_TOKEN", "SECRET_BEARER", "SECRET_BODY", "example.test"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
