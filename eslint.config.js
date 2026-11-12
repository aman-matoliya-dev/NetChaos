import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Globals that the core library must never touch. This enforces the
 * "no browser-only / Node-only APIs in the core runtime" requirement.
 */
const forbiddenCoreGlobals = [
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
].map((name) => ({
  name,
  message: `NetChaos core must be runtime-neutral and must not reference "${name}".`,
}));

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true },
    },
  },

  // Core library rules.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", ...forbiddenCoreGlobals],
      "no-console": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },

  // Tests: relax a few rules that are noisy for test code (mocks, non-null access to
  // known fixtures). Everything else, including no-floating-promises, still applies.
  {
    files: ["tests/**/*.ts", "examples/**/*.ts"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },

  // Plain JS files (this config) are not part of a TS project.
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Must stay last: turns off rules that conflict with Prettier.
  prettier,
);
