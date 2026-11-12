import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NetChaosConfigError, SimulatedNetworkError, createNetChaos } from "../src";
import { sequence, settle } from "./helpers";

/**
 * End-to-end tests with the REAL global fetch against a LOCAL HTTP server
 * (127.0.0.1). No external network is used. Real timers with small delays.
 */
interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let baseUrl = "";
let seen: Seen[] = [];

function handle(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
    const respond = () => {
      if (req.url?.startsWith("/missing")) {
        res.writeHead(404, { "content-type": "application/json", "x-server": "test" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "x-server": "test" });
      res.end(JSON.stringify({ method: req.method, path: req.url, body }));
    };
    if (req.url?.startsWith("/slow")) setTimeout(respond, 300);
    else respond();
  });
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});
beforeEach(() => {
  seen = [];
});

describe("real fetch through NetChaos", () => {
  it("quick start: GET returns a normal Response the caller can parse", async () => {
    const chaos = createNetChaos({ profile: "fast" });
    const response = await chaos.fetch(`${baseUrl}/api/users`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-server")).toBe("test");
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toMatchObject({ method: "GET", path: "/api/users" });
    expect(seen).toHaveLength(1);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    it(`${method} with custom headers and a JSON body reaches the server intact`, async () => {
      const chaos = createNetChaos({ profile: "slow-3g", latency: 20 });
      const payload = JSON.stringify({ name: "widget", method });
      const response = await chaos.fetch(`${baseUrl}/items`, {
        method,
        headers: { "content-type": "application/json", authorization: "Bearer abc", "x-trace": "t-1" },
        ...(method === "DELETE" ? {} : { body: payload }),
      });
      expect(response.status).toBe(200);
      const request = seen[0];
      expect(request?.method).toBe(method);
      expect(request?.headers["content-type"]).toBe("application/json");
      expect(request?.headers.authorization).toBe("Bearer abc");
      expect(request?.headers["x-trace"]).toBe("t-1");
      expect(request?.body).toBe(method === "DELETE" ? "" : payload);
    });
  }

  it("accepts a Request object (with a body) and a URL object", async () => {
    const chaos = createNetChaos({ profile: "slow-3g", latency: 20 });
    const request = new Request(`${baseUrl}/from-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: 1 }),
    });
    const first = await chaos.fetch(request);
    expect(((await first.json()) as { body: string }).body).toBe('{"q":1}');
    const second = await chaos.fetch(new URL(`${baseUrl}/from-url`));
    expect(((await second.json()) as { path: string }).path).toBe("/from-url");
  });

  it("returns HTTP error statuses untouched", async () => {
    const response = await createNetChaos().fetch(`${baseUrl}/missing`);
    expect(response.status).toBe(404);
    expect(response.headers.get("x-server")).toBe("test");
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("slow-3g really delays the request before it reaches the server", async () => {
    const chaos = createNetChaos({ profile: "slow-3g", latency: 150 });
    const started = performance.now();
    const pending = chaos.fetch(`${baseUrl}/delayed`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toHaveLength(0);
    await pending;
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    expect(seen).toHaveLength(1);
  });

  it("walks through the specification's profile-switching example", async () => {
    const chaos = createNetChaos({ profile: "slow-3g", latency: 30 });
    expect((await chaos.fetch(`${baseUrl}/api/products`)).status).toBe(200);
    expect(seen).toHaveLength(1);

    chaos.setProfile("offline");
    const result = await settle(chaos.fetch(`${baseUrl}/api/orders`));
    expect(result.status === "rejected" && result.reason).toBeInstanceOf(SimulatedNetworkError);
    expect(seen).toHaveLength(1);

    chaos.setProfile("fast");
    expect((await chaos.fetch(`${baseUrl}/api/orders`)).status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it("a simulated failure never reaches the server", async () => {
    const chaos = createNetChaos({ failureRate: 1 });
    for (let i = 0; i < 10; i++) await settle(chaos.fetch(`${baseUrl}/never`));
    expect(seen).toHaveLength(0);
  });

  it("unstable with deterministic randomness: failing requests never reach the server, survivors do", async () => {
    // Each request draws jitter first, then the failure roll.
    const random = sequence([0.5, 0.1, 0.5, 0.9, 0.5, 0.2, 0.5, 0.8]);
    const chaos = createNetChaos({ profile: "unstable", latency: 10, random });
    const outcomes: string[] = [];
    for (const path of ["/a", "/b", "/c", "/d"]) outcomes.push((await settle(chaos.fetch(`${baseUrl}${path}`))).status);
    expect(outcomes).toEqual(["rejected", "fulfilled", "rejected", "fulfilled"]);
    expect(seen.map((s) => s.path)).toEqual(["/b", "/d"]);
  });

  it("two instances with different profiles work concurrently against the same server", async () => {
    const online = createNetChaos({ profile: "slow-3g", latency: 20 });
    const offline = createNetChaos({ profile: "offline" });
    const [good, bad] = await Promise.all([settle(online.fetch(`${baseUrl}/ok`)), settle(offline.fetch(`${baseUrl}/no`))]);
    expect(good.status).toBe("fulfilled");
    expect(bad.status).toBe("rejected");
    expect(seen.map((s) => s.path)).toEqual(["/ok"]);
  });
});

describe("real fetch: errors and cancellation", () => {
  it("a genuine network failure (connection refused) propagates natively, not as a simulated failure", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      closed.close(() => {
        resolve();
      });
    });
    const result = await settle(createNetChaos().fetch(`http://127.0.0.1:${String(port)}/`));
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.reason).toBeInstanceOf(TypeError);
    expect(result.status === "rejected" && result.reason).not.toBeInstanceOf(SimulatedNetworkError);
  });

  it("abort during the artificial latency means the server is never contacted", async () => {
    const chaos = createNetChaos({ profile: "slow-3g", latency: 500 });
    const controller = new AbortController();
    const pending = settle(chaos.fetch(`${baseUrl}/never`, { signal: controller.signal }));
    setTimeout(() => {
      controller.abort();
    }, 30);
    const result = await pending;
    expect(result.status === "rejected" && result.reason).toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toHaveLength(0);
  });

  it("abort while the real request is in flight is handled by native fetch", async () => {
    const chaos = createNetChaos({ latency: 10 });
    const controller = new AbortController();
    const pending = settle(chaos.fetch(`${baseUrl}/slow`, { signal: controller.signal }));
    setTimeout(() => {
      controller.abort();
    }, 100);
    const result = await pending;
    expect(result.status === "rejected" && result.reason).toMatchObject({ name: "AbortError" });
  });

  it("an already-aborted request is not sent", async () => {
    const result = await settle(createNetChaos().fetch(`${baseUrl}/never`, { signal: AbortSignal.abort() }));
    expect(result.status).toBe("rejected");
    expect(seen).toHaveLength(0);
  });

  it("invalid configuration is rejected before any request is made", () => {
    expect(() => createNetChaos({ failureRate: 3 })).toThrow(NetChaosConfigError);
    expect(seen).toHaveLength(0);
  });
});
