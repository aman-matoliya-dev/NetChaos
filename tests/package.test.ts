import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Verifies the BUILT package (dist/): exports map, ESM and CommonJS entry
 * points, runtime neutrality, and generated TypeScript declarations.
 *
 * These tests need `npm run build` first. When dist/ is missing they are
 * skipped (visibly) so a fresh `npm test` still works; `npm run check` and
 * `npm run test:package` always build before testing.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dist = (file: string) => join(ROOT, "dist", file);

const built = ["index.js", "index.cjs", "index.d.ts", "index.d.cts"].every((f) =>
  existsSync(dist(f)),
);

if (!built) {
  console.warn("[netchaos] dist/ not found: package tests are skipped. Run `npm run build` first.");
}

const describeBuilt = describe.skipIf(!built);

const PUBLIC_EXPORTS = [
  "NetChaos",
  "NetChaosConfigError",
  "NetChaosError",
  "SimulatedNetworkError",
  "createNetChaos",
];

const SLOW = 120_000;

function node(args: string[]): string {
  return execFileSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
}

describeBuilt("package.json and dist layout", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    name: string;
    type: string;
    main: string;
    module: string;
    types: string;
    exports: Record<string, Record<string, Record<string, string>> | string>;
    files: string[];
    engines: { node: string };
    sideEffects: boolean;
    dependencies?: object;
  };

  it("declares the expected metadata", () => {
    expect(pkg.name).toBe("netchaos");
    expect(pkg.type).toBe("module");
    expect(pkg.engines.node).toBe(">=18");
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.dependencies).toBeUndefined();
  });

  it("every file referenced by main/module/types/exports exists in dist", () => {
    const root = pkg.exports["."] as Record<string, Record<string, string>>;
    const targets = [
      pkg.main,
      pkg.module,
      pkg.types,
      root.import?.types,
      root.import?.default,
      root.require?.types,
      root.require?.default,
    ];

    for (const target of targets) {
      expect(typeof target).toBe("string");
      expect(existsSync(join(ROOT, target ?? "missing"))).toBe(true);
    }
  });

  it("publishes only dist and documentation files", () => {
    expect([...pkg.files].sort()).toEqual(["CHANGELOG.md", "LICENSE", "README.md", "dist"]);
  });
});

describeBuilt("ESM and CommonJS entry points", () => {
  it("ESM build exports exactly the public API", async () => {
    const esm = (await import(pathToFileURL(dist("index.js")).href)) as Record<string, unknown>;
    expect(Object.keys(esm).sort()).toEqual(PUBLIC_EXPORTS);
    expect(typeof esm.createNetChaos).toBe("function");
  });

  it("CommonJS build exports exactly the public API", () => {
    const cjs = createRequire(import.meta.url)(dist("index.cjs")) as Record<string, unknown>;
    expect(Object.keys(cjs).sort()).toEqual(PUBLIC_EXPORTS);
    expect(typeof cjs.createNetChaos).toBe("function");
  });

  it("both builds behave identically (offline fails with the stable code, fetch untouched)", async () => {
    const esm = (await import(pathToFileURL(dist("index.js")).href)) as typeof import("../src");
    const cjs = createRequire(import.meta.url)(dist("index.cjs")) as typeof import("../src");

    for (const lib of [esm, cjs]) {
      let calls = 0;
      const chaos = lib.createNetChaos({
        profile: "offline",
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response("ok"));
        },
      });

      const error: unknown = await chaos.fetch("/x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({
        code: "NETCHAOS_SIMULATED_FAILURE",
        profile: "offline",
      });
      expect(calls).toBe(0);
    }
  });

  it("the stable `code` works across the dual-package boundary (class identity may differ)", async () => {
    const esm = (await import(pathToFileURL(dist("index.js")).href)) as typeof import("../src");
    const cjs = createRequire(import.meta.url)(dist("index.cjs")) as typeof import("../src");

    const fromCjs: unknown = await cjs
      .createNetChaos({ profile: "offline" })
      .fetch("/x")
      .catch((e: unknown) => e);

    expect((fromCjs as { code: string }).code).toBe("NETCHAOS_SIMULATED_FAILURE");
    expect(esm.SimulatedNetworkError.name).toBe(cjs.SimulatedNetworkError.name);
  });

  it(
    "resolves through the package.json exports map with real Node resolution (import and require)",
    () => {
      const script = `
        const m = await import("netchaos");
        const r = (await import("node:module")).createRequire(process.cwd() + "/");
        const c = r("netchaos");
        console.log(JSON.stringify({
          esm: Object.keys(m).sort(),
          cjs: Object.keys(c).sort(),
          cjsPath: r.resolve("netchaos").split(/[\\\\/]/).slice(-2).join("/"),
        }));`;

      const out = JSON.parse(node(["--input-type=module", "-e", script])) as {
        esm: string[];
        cjs: string[];
        cjsPath: string;
      };

      expect(out.esm).toEqual(PUBLIC_EXPORTS);
      expect(out.cjs).toEqual(PUBLIC_EXPORTS);
      expect(out.cjsPath).toBe("dist/index.cjs");
    },
    SLOW,
  );

  it(
    "importing the package has no side effects on globals (ESM and CJS)",
    () => {
      const check = (loader: string) => `
        const before = new Set(Object.getOwnPropertyNames(globalThis));
        const f = globalThis.fetch;
        ${loader}
        const added = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k));
        console.log(JSON.stringify({ added, fetchSame: globalThis.fetch === f }));`;

      const esm = node(["--input-type=module", "-e", check('await import("netchaos");')]);
      const cjs = node(["-e", check('require("netchaos");')]);

      expect(JSON.parse(esm)).toEqual({ added: [], fetchSame: true });
      expect(JSON.parse(cjs)).toEqual({ added: [], fetchSame: true });
    },
    SLOW,
  );
});

describeBuilt("runtime neutrality of the built bundle", () => {
  it("runs in a bare JavaScript context with no window, document, process, require, Buffer or fetch", async () => {
    const sandbox: Record<string, unknown> = {
      setTimeout,
      clearTimeout,
      AbortController,
      DOMException,
      Response,
      Request,
    };

    const context = vm.createContext(sandbox);
    const module_ = { exports: {} as Record<string, unknown> };

    const wrapper = vm.runInContext(
      `(function (module, exports) {${readFileSync(dist("index.cjs"), "utf8")}\n})`,
      context,
    ) as (m: typeof module_, e: object) => void;

    wrapper(module_, module_.exports);
    sandbox.nc = module_.exports;

    const result = (await vm.runInContext(
      `(async () => {
        const seen = [
          typeof window,
          typeof document,
          typeof process,
          typeof require,
          typeof Buffer,
          typeof fetch,
          typeof navigator,
        ];
        let calls = 0;
        const chaos = nc.createNetChaos({
          profile: "slow-3g",
          latency: 10,
          fetch: () => {
            calls++;
            return Promise.resolve(new Response("ok"));
          },
        });
        const body = await (await chaos.fetch("/x")).text();
        chaos.setProfile("offline");
        let error;
        try {
          await chaos.fetch("/y");
        } catch (e) {
          error = e;
        }
        return JSON.stringify({
          seen,
          body,
          calls,
          code: error && error.code,
          isTypeError: error instanceof TypeError,
        });
      })()`,
      context,
    )) as string;

    expect(JSON.parse(result)).toEqual({
      seen: Array<string>(7).fill("undefined"),
      body: "ok",
      calls: 1,
      code: "NETCHAOS_SIMULATED_FAILURE",
      isTypeError: true,
    });
  });
});

/**
 * Compiles a real temporary consumer file against the built package.
 *
 * A real file is used instead of a virtual CompilerHost file because
 * TypeScript's Node16 resolver needs a real filesystem location to resolve
 * the package self-reference and its conditional exports consistently
 * across Windows and POSIX.
 */
function diagnose(source: string, extension: ".mts" | ".cts"): string[] {
  const tempDir = mkdtempSync(join(ROOT, ".netchaos-consumer-"));
  const file = join(tempDir, `consumer${extension}`);

  try {
    writeFileSync(file, source, "utf8");

    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      types: [],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    };

    const program = ts.createProgram([file], options);

    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => `TS${String(d.code)}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const CONSUMER = `
import { createNetChaos, NetChaos, NetChaosConfigError, NetChaosError, SimulatedNetworkError } from "netchaos";
import type { CustomConditions, FetchLike, NetChaosConfig, NetChaosErrorCode, NetChaosOptions, NetworkProfile, RandomSource } from "netchaos";

const chaos: NetChaos = createNetChaos({ profile: "unstable", latency: 100, failureRate: 0.2 });
const profile: NetworkProfile = chaos.profile;
const config: NetChaosConfig = chaos.getConfig();
const latency: number = config.latency;
const rate: number = config.failureRate;
chaos.setProfile("offline");
chaos.clearOverrides();
const a: Promise<Response> = chaos.fetch("/api/users");
const b = chaos.fetch(new URL("https://example.com"), { method: "POST", body: "{}" });
const c = chaos.fetch(new Request("https://example.com"));
const asFetchLike: FetchLike = chaos.fetch;
const asGlobalFetch: typeof fetch = chaos.fetch;
const random: RandomSource = () => 0.5;
const options: NetChaosOptions = { fetch: asFetchLike, random };
const custom: CustomConditions = { latency: 1, failureRate: 0 };
const code: NetChaosErrorCode = "NETCHAOS_INVALID_CONFIG";
const direct: NetChaos = new NetChaos(options);

try {
  await Promise.resolve();
} catch (error) {
  if (error instanceof SimulatedNetworkError) {
    const stable: "NETCHAOS_SIMULATED_FAILURE" = error.code;
    const which: NetworkProfile = error.profile;
    const asTypeError: TypeError = error;
    void [stable, which, asTypeError];
  }

  if (error instanceof NetChaosConfigError) {
    const base: NetChaosError = error;
    void base;
  }
}

// @ts-expect-error unknown profile name
createNetChaos({ profile: "bogus" });
// @ts-expect-error latency must be a number
createNetChaos({ latency: "100" });
// @ts-expect-error failureRate must be a number
createNetChaos({ failureRate: "0.5" });
// @ts-expect-error jitter is not a public option
createNetChaos({ jitter: 5 });
// @ts-expect-error unknown profile for setProfile
chaos.setProfile("wifi");
// @ts-expect-error fetch is read-only
chaos.fetch = asFetchLike;
// @ts-expect-error profile is a read-only getter
chaos.profile = "fast";
// @ts-expect-error config is read-only
config.latency = 5;

void [profile, latency, rate, a, b, c, asGlobalFetch, custom, code, direct];
`;

describeBuilt("generated TypeScript declarations", () => {
  it(
    "type-check for ESM consumers (types condition: import -> index.d.ts), including expected errors",
    () => {
      expect(diagnose(CONSUMER, ".mts")).toEqual([]);
    },
    SLOW,
  );

  it(
    "type-check for CommonJS consumers (types condition: require -> index.d.cts), including expected errors",
    () => {
      expect(diagnose(CONSUMER.replace("await Promise.resolve();", "void 0;"), ".cts")).toEqual([]);
    },
    SLOW,
  );

  it(
    "really are checked: invalid usage is reported (guards against a vacuous pass)",
    () => {
      const diagnostics = diagnose(
        `import { createNetChaos } from "netchaos"; createNetChaos({ profile: "bogus" }); export {};`,
        ".mts",
      );

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.join("\n")).toContain("bogus");
    },
    SLOW,
  );

  it("declare every public export", () => {
    for (const file of ["index.d.ts", "index.d.cts"]) {
      const text = readFileSync(dist(file), "utf8");

      for (const name of PUBLIC_EXPORTS) {
        expect(text).toContain(name);
      }

      // Jitter is internal: no declared `jitter` member may appear (doc comments may mention it).
      expect(text).not.toMatch(/\bjitter\s*\??\s*:/);
    }
  });
});
