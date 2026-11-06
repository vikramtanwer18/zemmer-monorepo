import { createServer, type Server } from "node:http";
import type { PrismaClient } from "@gym/db";
import type { Redis } from "ioredis";

const CHECK_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

async function check(fn: () => Promise<unknown>): Promise<"ok" | "down"> {
  try {
    await withTimeout(fn());
    return "ok";
  } catch {
    return "down";
  }
}

/** GET /health → 200 only when Redis answers PING and Postgres answers SELECT 1. */
export function startHealthServer(
  port: number,
  redis: Redis,
  db: PrismaClient,
): Server {
  const server = createServer(async (req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const [redisStatus, database] = await Promise.all([
      check(() => redis.ping()),
      check(() => db.$queryRaw`SELECT 1`),
    ]);
    const ok = redisStatus === "ok" && database === "ok";
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(
      JSON.stringify({
        status: ok ? "ok" : "error",
        checks: { redis: redisStatus, database },
      }),
    );
  });
  server.listen(port);
  return server;
}
