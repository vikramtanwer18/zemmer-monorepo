import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type { NextConfig } from "next";

// Next.js only reads .env from the app folder; load the monorepo root one instead.
const monorepoRoot = path.resolve(process.cwd(), "../..");
loadDotenv({ path: path.join(monorepoRoot, ".env"), quiet: true });

// Development only: VS Code port forwarding / dev tunnels add an `x-forwarded-host` of the tunnel
// (e.g. *.devtunnels.ms) while the browser's Origin stays the local URL, which Next.js rejects as
// a cross-site Server Action. Trust only our own ADMIN_URL origin, and only in `next dev`.
// Production keeps Next.js's default same-origin check.
const isDev = process.env.NODE_ENV === "development";
function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}
const devActionOrigins = isDev
  ? [hostOf(process.env.ADMIN_URL)].filter((h): h is string => !!h)
  : [];

const nextConfig: NextConfig = {
  // Standalone output is only for Docker images; `next start` does not support it.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  outputFileTracingRoot: monorepoRoot,
  experimental: {
    agentFeedback: true,
    ...(devActionOrigins.length
      ? { serverActions: { allowedOrigins: devActionOrigins } }
      : {}),
  },
  // Dev-only: hot reload through 127.0.0.1 or a VS Code dev tunnel.
  allowedDevOrigins: ["127.0.0.1", "*.devtunnels.ms"],
  transpilePackages: [
    "@gym/ui",
    "@gym/db",
    "@gym/core",
    "@gym/env",
    "@gym/auth",
    "@gym/integrations",
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  turbopack: {
    root: monorepoRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
