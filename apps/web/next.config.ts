import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type { NextConfig } from "next";

// Next.js only reads .env from the app folder; load the monorepo root one instead.
const monorepoRoot = path.resolve(process.cwd(), "../..");
loadDotenv({ path: path.join(monorepoRoot, ".env"), quiet: true });

// Development only: VS Code port forwarding / dev tunnels add an `x-forwarded-host` of the tunnel
// (e.g. *.devtunnels.ms) while the browser's Origin stays the local URL, which Next.js rejects as
// a cross-site Server Action. Trust only our own APP_URL origin, and only in `next dev`.
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
  ? [hostOf(process.env.APP_URL)].filter((h): h is string => !!h)
  : [];

const nextConfig: NextConfig = {
  // Standalone output is only for Docker images; `next start` does not support it.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  outputFileTracingRoot: monorepoRoot,
  ...(devActionOrigins.length
    ? { experimental: { serverActions: { allowedOrigins: devActionOrigins } } }
    : {}),
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
  // The member app lives at /m/ (trailing slash) so its home page is inside the service worker
  // scope "/m/" (a scope of "/m" would also capture staff routes such as /members).
  // proxy.ts redirects /m → /m/; this stops Next.js from redirecting it back.
  skipTrailingSlashRedirect: true,
  turbopack: {
    root: monorepoRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        // Everything except a capture form's embed variant, which sends its own policy
        // (frame-ancestors limited to the sites listed on the form).
        source: "/((?!l/[^/]+/[^/]+/embed$).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // If browsers cached the service worker, fixes would never reach members' phones.
        source: "/m/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          { key: "Service-Worker-Allowed", value: "/m/" },
        ],
      },
    ];
  },
};

export default nextConfig;
