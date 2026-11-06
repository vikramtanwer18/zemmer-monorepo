// Bundles the worker into one ESM file for the Docker image.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
  platform: "node",
  target: "node24",
  format: "esm",
  // Bundle everything: with pnpm, third-party packages live in each workspace package's own
  // node_modules, so leaving them external fails at runtime with "Cannot find package".
  bundle: true,
  // Optional native add-on of `pg` that we don't use.
  external: ["pg-native"],
  sourcemap: true,
  // Some bundled dependencies are CommonJS and call require().
  banner: {
    js: "import { createRequire as __gymCreateRequire } from 'node:module'; const require = __gymCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
