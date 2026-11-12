import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  tsconfig: "tsconfig.build.json",
  // Runtime-neutral output: no Node shims, no browser assumptions.
  platform: "neutral",
  target: "es2022",
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
});
