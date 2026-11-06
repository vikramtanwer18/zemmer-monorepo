import { config, noAppImports } from "@gym/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    // This package owns the generated client, so it may import it directly.
    rules: {
      "no-restricted-imports": ["warn", { patterns: [noAppImports] }],
    },
  },
];
