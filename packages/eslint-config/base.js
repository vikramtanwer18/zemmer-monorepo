import babelParser from "@babel/eslint-parser";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import onlyWarn from "eslint-plugin-only-warn";

/** Packages never import from apps: dependencies point inward. */
export const noAppImports = {
  group: ["**/apps/**"],
  message:
    "Packages must not import from apps. Move shared code into a package.",
};

/** Everyone imports the Prisma client from @gym/db, never from its generated folder. */
export const noGeneratedImports = {
  group: ["**/generated/**", "@gym/db/generated", "@gym/db/generated/**"],
  message: "Import the database client and types from @gym/db.",
};

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
  // Flat config only lints .js files unless told otherwise.
  { files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"] },
  js.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ["@babel/preset-typescript"],
          // JSX only in .tsx, so generic arrows like <T>(x) => x still parse in .ts files.
          overrides: [{ test: /\.tsx$/, parserOpts: { plugins: ["jsx"] } }],
        },
      },
    },
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      // NEXT_RUNTIME is set by Next.js itself, not read from our environment.
      "turbo/no-undeclared-env-vars": [
        "warn",
        { allowList: ["^NEXT_RUNTIME$"] },
      ],
      // TypeScript checks these, and the JS rules misfire on type-only syntax.
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-redeclare": "off",
      // False positives on typed destructured parameters with the Babel parser.
      "no-dupe-args": "off",
      "no-restricted-imports": [
        "warn",
        { patterns: [noAppImports, noGeneratedImports] },
      ],
    },
  },
  {
    plugins: {
      onlyWarn,
    },
  },
  {
    ignores: [
      "dist/**",
      "generated/**",
      ".next/**",
      "test-results/**",
      "playwright-report/**",
      "blob-report/**",
      "next-env.d.ts",
    ],
  },
];
