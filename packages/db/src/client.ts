import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

export type CreatePrismaClientOptions = {
  /** Maximum pool size. Defaults to the pg default (10). */
  maxConnections?: number;
};

/** Builds a PrismaClient for one connection string, using the node-postgres driver adapter. */
export function createPrismaClient(
  url: string,
  options: CreatePrismaClientOptions = {},
): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: url,
    ...(options.maxConnections ? { max: options.maxConnections } : {}),
  });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as typeof globalThis & {
  __gymPrismaClients?: Map<string, PrismaClient>;
};

/**
 * Returns a cached client per connection string. Cached on globalThis so Next.js dev reloads
 * reuse the pool instead of opening a new one on every change.
 */
export function getPrismaClient(url: string): PrismaClient {
  globalForPrisma.__gymPrismaClients ??= new Map();
  let client = globalForPrisma.__gymPrismaClients.get(url);
  if (!client) {
    client = createPrismaClient(url);
    globalForPrisma.__gymPrismaClients.set(url, client);
  }
  return client;
}
