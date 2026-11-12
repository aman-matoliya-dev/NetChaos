import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNetChaos } from "../src";
import { createMockFetch, settle } from "./helpers";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listSources(full) : full.endsWith(".ts") ? [full] : [];
  });
}

/** Removes comments and string/template contents so only real code is scanned. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

describe("runtime-neutral core (static checks over src/)", () => {
  const files = listSources(SRC);

  it("finds the expected source files", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  const forbiddenIdentifiers = [
    "window",
    "document",
    "navigator",
    "location",
    "localStorage",
    "sessionStorage",
    "process",
    "global",
    "Buffer",
    "require",
    "__dirname",
    "__filename",
    "eval",
    "XMLHttpRequest",
  ];

  for (const identifier of forbiddenIdentifiers) {
    it(`never references \`${identifier}\``, () => {
      const offenders = files.filter((file) =>
        new RegExp(`(?<![.\\w$])${identifier}(?![\\w$])`).test(codeOnly(readFileSync(file, "utf8"))),
      );
      expect(offenders).toEqual([]);
    });
  }

  it("imports no Node.js built-ins and no third-party packages (zero runtime dependencies)", () => {
    for (const file of files) {
      const imports = [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      for (const specifier of imports) expect(specifier.startsWith(".")).toBe(true);
    }
  });

  it("never patches globals: the only global it touches is reading globalThis.fetch", () => {
    const uses = files.flatMap((file) =>
      [...codeOnly(readFileSync(file, "utf8")).matchAll(/globalThis[^;\n]*/g)].map((m) => m[0]),
    );
    expect(uses).toHaveLength(1);
    expect(uses[0]).toContain(".fetch");
    for (const file of files) {
      expect(codeOnly(readFileSync(file, "utf8"))).not.toMatch(/globalThis\s*(\.\w+|\[[^\]]+\])\s*=[^=]/);
    }
  });

  it("does not use eval, Function constructors or console output", () => {
    for (const file of files) {
      const code = codeOnly(readFileSync(file, "utf8"));
      expect(code).not.toMatch(/\bnew\s+Function\b/);
      expect(code).not.toMatch(/\bconsole\./);
    }
  });
});

describe("runtime behaviour in a plain environment", () => {
  it("works with no browser globals present", async () => {
    expect(typeof (globalThis as Record<string, unknown>).window).toBe("undefined");
    expect(typeof (globalThis as Record<string, unknown>).document).toBe("undefined");
    const fetchMock = createMockFetch();
    const result = await settle(createNetChaos({ fetch: fetchMock }).fetch("/x"));
    expect(result.status).toBe("fulfilled");
  });

  it("importing and using the library adds no globals", async () => {
    const before = new Set(Object.getOwnPropertyNames(globalThis));
    const chaos = createNetChaos({ profile: "unstable", latency: 0, fetch: createMockFetch() });
    chaos.setProfile("offline");
    await settle(chaos.fetch("/x"));
    const added = Object.getOwnPropertyNames(globalThis).filter((name) => !before.has(name));
    expect(added).toEqual([]);
  });
});
