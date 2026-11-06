import { Prisma, type PrismaClient } from "../generated/prisma/client";
import { isTenantModel } from "./tenant-models";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantTransaction = Prisma.TransactionClient;

export class InvalidTenantIdError extends Error {
  constructor(what = "Tenant id") {
    super(`${what} must be a UUID`);
    this.name = "InvalidTenantIdError";
  }
}

/** Thrown when code tries to write a row for a different tenant than the one in scope. */
export class TenantMismatchError extends Error {
  constructor(model: string) {
    super(`${model}: tenantId does not match the tenant in scope`);
    this.name = "TenantMismatchError";
  }
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

type Args = Record<string, unknown>;

function scopeWhere(where: unknown, tenantId: string): Args {
  return { ...((where as Args | undefined) ?? {}), tenantId };
}

function stampData(model: string, data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => stampData(model, item, tenantId));
  }
  const row = (data as Args | undefined) ?? {};
  if (row.tenantId !== undefined && row.tenantId !== tenantId) {
    throw new TenantMismatchError(model);
  }
  // Rows created through a relation (e.g. `tenant: { connect }`) carry no tenantId field.
  if ("tenant" in row) {
    return row;
  }
  return { ...row, tenantId };
}

/**
 * Prisma extension for the first isolation layer (D-05): adds `tenantId` to every filter and
 * every created row of a tenant-owned model. RLS is the second layer, so a model missing from
 * the registry still returns nothing instead of another tenant's rows.
 */
export function tenantScope(tenantId: string) {
  return Prisma.defineExtension({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isTenantModel(model)) {
            return query(args);
          }
          const a = { ...(args as Args) };
          switch (operation) {
            case "findUnique":
            case "findUniqueOrThrow":
            case "findFirst":
            case "findFirstOrThrow":
            case "findMany":
            case "count":
            case "aggregate":
            case "groupBy":
            case "update":
            case "updateMany":
            case "updateManyAndReturn":
            case "delete":
            case "deleteMany":
              a.where = scopeWhere(a.where, tenantId);
              break;
            case "create":
            case "createMany":
            case "createManyAndReturn":
              a.data = stampData(model, a.data, tenantId);
              break;
            case "upsert":
              a.where = scopeWhere(a.where, tenantId);
              a.create = stampData(model, a.create, tenantId);
              break;
            default:
              break;
          }
          return query(a as typeof args);
        },
      },
    },
  });
}

/**
 * Runs `fn` inside a transaction scoped to one tenant:
 * - `app.tenant_id` is set for this transaction only, so RLS policies apply;
 * - the client passed to `fn` adds `tenantId` to every tenant-owned query.
 */
export async function withTenant<T>(
  db: PrismaClient,
  tenantId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
  options: { userId?: string } = {},
): Promise<T> {
  if (!isUuid(tenantId)) {
    throw new InvalidTenantIdError();
  }
  if (options.userId !== undefined && !isUuid(options.userId)) {
    throw new InvalidTenantIdError("User id");
  }
  const scoped = db.$extends(tenantScope(tenantId));
  return scoped.$transaction(async (tx) => {
    // `true` = local to this transaction, so the value never leaks to the next user of the connection.
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    if (options.userId) {
      await tx.$queryRaw`SELECT set_config('app.user_id', ${options.userId}, true)`;
    }
    return fn(tx as unknown as TenantTransaction);
  });
}

/**
 * Runs `fn` with only the user set. RLS then shows that user's own memberships across tenants
 * (and those tenants' rows), which is what the tenant picker needs. Nothing else is visible.
 */
export async function withUser<T>(
  db: PrismaClient,
  userId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  if (!isUuid(userId)) {
    throw new InvalidTenantIdError("User id");
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  });
}

/**
 * Like Promise.all for Prisma queries, but runs them one after another. Use it inside
 * transactions: they share one connection, and parallel queries on it are queued anyway (and
 * deprecated by node-postgres). Prisma queries are lazy, so building the array starts nothing.
 */
export async function inOrder<T extends readonly unknown[]>(
  queries: readonly [...{ [K in keyof T]: PromiseLike<T[K]> }],
): Promise<T> {
  const results: unknown[] = [];
  for (const query of queries) results.push(await query);
  return results as unknown as T;
}
