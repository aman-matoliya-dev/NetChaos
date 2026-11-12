import { afterEach, describe, expect, it, vi } from "vitest";
import { NetChaosConfigError, SimulatedNetworkError, createNetChaos } from "../src";
import type { FetchLike } from "../src";
import { callArgs, createMockFetch, rejectingWith, settle, startWithoutThrowing } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inputs: string, URL, Request, RequestInit", () => {
  it("forwards a string URL exactly (same single argument)", async () => {
    const fetchMock = createMockFetch();
    await createNetChaos({ fetch: fetchMock }).fetch("/api/users");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callArgs(fetchMock)).toEqual(["/api/users"]);
    expect(callArgs(fetchMock)).toHaveLength(1);
  });

  it("forwards a URL object by identity", async () => {
    const fetchMock = createMockFetch();
    const url = new URL("https://example.test/items?page=2");
    await createNetChaos({ fetch: fetchMock }).fetch(url);
    expect(callArgs(fetchMock)[0]).toBe(url);
  });

  it("forwards a Request object by identity and never consumes or locks its body", async () => {
    const fetchMock = createMockFetch();
    const request = new Request("https://example.test/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "widget" }),
    });
    await createNetChaos({ fetch: fetchMock }).fetch(request);
    expect(callArgs(fetchMock)[0]).toBe(request);
    expect(request.bodyUsed).toBe(false);
    expect(request.body?.locked).toBe(false);
    expect(await request.json()).toEqual({ name: "widget" });
  });

  it("forwards a Request together with an init argument, both by identity", async () => {
    const fetchMock = createMockFetch();
    const request = new Request("https://example.test/a");
    const init: RequestInit = { headers: { "x-extra": "1" } };
    await createNetChaos({ fetch: fetchMock }).fetch(request, init);
    expect(callArgs(fetchMock)[0]).toBe(request);
    expect(callArgs(fetchMock)[1]).toBe(init);
  });

  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  for (const method of methods) {
    it(`preserves ${method} method, headers and JSON body without touching the init object`, async () => {
      const fetchMock = createMockFetch();
      const headers = Object.freeze({
        "content-type": "application/json",
        authorization: "Bearer test-token",
        "x-request-id": "abc-123",
      });
      const init: RequestInit = Object.freeze({
        method,
        headers,
        ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify({ id: 1, ok: true }) }),
      });
      await createNetChaos({ fetch: fetchMock }).fetch("/api/resource", init);
      const forwarded = callArgs(fetchMock)[1];
      expect(forwarded).toBe(init);
      expect(forwarded?.method).toBe(method);
      expect(forwarded?.headers).toBe(headers);
      expect(forwarded?.body).toBe(method === "GET" || method === "DELETE" ? undefined : '{"id":1,"ok":true}');
    });
  }

  it("preserves a Headers instance by identity", async () => {
    const fetchMock = createMockFetch();
    const headers = new Headers({ accept: "application/json" });
    const init: RequestInit = { headers };
    await createNetChaos({ fetch: fetchMock }).fetch("/x", init);
    expect(callArgs(fetchMock)[1]?.headers).toBe(headers);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("forwards the caller's exact arity (an explicit undefined init is kept as given)", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ fetch: fetchMock });
    await chaos.fetch("/one");
    await chaos.fetch("/two", undefined);
    expect(callArgs(fetchMock, 0)).toHaveLength(1);
    expect(callArgs(fetchMock, 1)).toHaveLength(2);
  });
});

describe("responses pass through untouched", () => {
  it("returns the very same Response object, status, headers and unread body", async () => {
    const original = new Response(JSON.stringify([{ id: 1 }]), {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json", "x-custom": "yes" },
    });
    const chaos = createNetChaos({ fetch: createMockFetch(() => Promise.resolve(original)) });
    const response = await chaos.fetch("/api/users");
    expect(response).toBe(original);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-custom")).toBe("yes");
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toEqual([{ id: 1 }]);
  });

  it("does not turn HTTP error statuses into rejections or alter them", async () => {
    for (const status of [400, 404, 500, 503]) {
      const original = new Response("nope", { status });
      const chaos = createNetChaos({ fetch: createMockFetch(() => Promise.resolve(original)) });
      const result = await settle(chaos.fetch("/x"));
      expect(result.status === "fulfilled" && result.value).toBe(original);
    }
  });

  it("returns network-error style Responses (Response.error()) unchanged", async () => {
    const original = Response.error();
    const chaos = createNetChaos({ fetch: createMockFetch(() => Promise.resolve(original)) });
    expect(await chaos.fetch("/x")).toBe(original);
  });

  it("returns a Promise", () => {
    const chaos = createNetChaos({ fetch: createMockFetch() });
    expect(chaos.fetch("/x")).toBeInstanceOf(Promise);
  });
});

describe("native errors and injected Fetch implementations", () => {
  it("propagates a native rejection as the identical error object (not wrapped)", async () => {
    const native = new TypeError("Failed to fetch");
    const chaos = createNetChaos({ fetch: createMockFetch(() => Promise.reject(native)) });
    const result = await settle(chaos.fetch("/x"));
    expect(result.status === "rejected" && result.reason).toBe(native);
    expect(result.status === "rejected" && result.reason).not.toBeInstanceOf(SimulatedNetworkError);
  });

  it("propagates non-Error rejection values unchanged", async () => {
    const rejectionValues: unknown[] = ["text", 404, null, undefined, { reason: "x" }];
    for (const value of rejectionValues) {
      const chaos = createNetChaos({ fetch: createMockFetch(() => rejectingWith(value)) });
      const result = await settle(chaos.fetch("/x"));
      expect(result.status).toBe("rejected");
      expect(result.status === "rejected" && result.reason).toBe(value);
    }
  });

  it("propagates DOMException rejections (for example a native AbortError) unchanged", async () => {
    const native = new DOMException("The operation was aborted", "AbortError");
    const chaos = createNetChaos({ fetch: createMockFetch(() => Promise.reject(native)) });
    const result = await settle(chaos.fetch("/x"));
    expect(result.status === "rejected" && result.reason).toBe(native);
  });

  it("converts a synchronous throw from the underlying fetch into a rejection (never a sync throw)", async () => {
    const native = new Error("sync boom");
    const chaos = createNetChaos({
      fetch: createMockFetch(() => {
        throw native;
      }),
    });
    const promise = startWithoutThrowing(() => chaos.fetch("/x"));
    const result = await settle(promise);
    expect(result.status === "rejected" && result.reason).toBe(native);
  });

  it("never retries a failing request", async () => {
    const fetchMock = createMockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await settle(createNetChaos({ fetch: fetchMock }).fetch("/x"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls the injected fetch as a plain function (no `this`)", async () => {
    const seen: unknown[] = [];
    const injected: FetchLike = function (this: unknown) {
      "use strict";
      seen.push(this);
      return Promise.resolve(new Response("ok"));
    };
    await createNetChaos({ fetch: injected }).fetch("/x");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeUndefined();
  });

  it("each instance uses only its own injected fetch", async () => {
    const a = createMockFetch();
    const b = createMockFetch();
    await createNetChaos({ fetch: a }).fetch("/a");
    await createNetChaos({ fetch: b }).fetch("/b");
    expect(callArgs(a)[0]).toBe("/a");
    expect(callArgs(b)[0]).toBe("/b");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("supports async injected implementations that resolve later", async () => {
    const chaos = createNetChaos({
      fetch: async () => {
        await Promise.resolve();
        return new Response("late");
      },
    });
    expect(await (await chaos.fetch("/x")).text()).toBe("late");
  });
});

describe("chaos.fetch is bound to its instance", () => {
  it("works when detached", async () => {
    const fetchMock = createMockFetch();
    const { fetch } = createNetChaos({ fetch: fetchMock });
    await fetch("/x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("works with Reflect.apply and an arbitrary `this`", async () => {
    const fetchMock = createMockFetch();
    const chaos = createNetChaos({ fetch: fetchMock });
    await Reflect.apply(chaos.fetch, { unrelated: true }, ["/x"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is assignable to the global fetch type", () => {
    const chaos = createNetChaos({ fetch: createMockFetch() });
    const asGlobal: typeof fetch = chaos.fetch;
    expect(asGlobal).toBe(chaos.fetch);
  });
});

describe("global fetch is never modified", () => {
  it("creating and using an instance leaves globalThis.fetch untouched", async () => {
    const globalMock = createMockFetch();
    vi.stubGlobal("fetch", globalMock);
    const chaos = createNetChaos({ profile: "slow-3g", latency: 0 });
    await chaos.fetch("/x");
    chaos.setProfile("offline");
    await settle(chaos.fetch("/y"));
    expect(globalThis.fetch).toBe(globalMock);
  });

  it("uses the global fetch captured at creation when none is injected", async () => {
    const original = createMockFetch();
    vi.stubGlobal("fetch", original);
    const chaos = createNetChaos();
    const replacement = createMockFetch();
    vi.stubGlobal("fetch", replacement);
    await chaos.fetch("/x");
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("cannot recurse infinitely if the user installs chaos.fetch as the global fetch", async () => {
    const original = createMockFetch();
    vi.stubGlobal("fetch", original);
    const chaos = createNetChaos();
    vi.stubGlobal("fetch", chaos.fetch);
    const result = await settle(chaos.fetch("/x"));
    expect(result.status).toBe("fulfilled");
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("an injected fetch takes precedence over the global one", async () => {
    const globalMock = createMockFetch();
    const injected = createMockFetch();
    vi.stubGlobal("fetch", globalMock);
    await createNetChaos({ fetch: injected }).fetch("/x");
    expect(injected).toHaveBeenCalledTimes(1);
    expect(globalMock).not.toHaveBeenCalled();
  });

  it("with no Fetch available at all, requests reject with a clear NetChaosConfigError", async () => {
    vi.stubGlobal("fetch", undefined);
    const chaos = createNetChaos();
    const result = await settle(chaos.fetch("/x"));
    expect(result.status === "rejected" && result.reason).toBeInstanceOf(NetChaosConfigError);
    expect(result.status === "rejected" && (result.reason as Error).message).toContain("No Fetch implementation");
  });
});
