import type { Prisma, PrismaClient, TenantTransaction } from "@gym/db";
import { withTenant, inOrder } from "@gym/db";
import { requirePermission, type AuthContext } from "../authz";

const SENSITIVE_KEY =
  /pass(word)?|token|secret|otp|code_?hash|authorization|cookie|api_?key|key_?secret|card|cvv/i;
const MAX_DEPTH = 6;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Deep copy for audit storage with secrets replaced. Dates → ISO, bigint → string. */
export function redactForAudit(value: unknown, depth = 0): JsonValue {
  if (value === null || value === undefined) return null;
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => redactForAudit(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : redactForAudit(inner, depth + 1);
    }
    return out;
  }
  return String(value);
}

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  branchId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
};

export type AuditActor =
  | Pick<AuthContext, "userId" | "tenantId" | "request">
  | { system: true; tenantId: string };

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return redactForAudit(value) as Prisma.InputJsonValue;
}

/**
 * Writes an audit row in the caller's transaction, so security and financial changes and their
 * audit entry commit or roll back together. A formatting problem in before/after/meta never
 * blocks the business change: the entry is still written, without the unformattable parts.
 */
export async function recordAudit(
  tx: TenantTransaction,
  actor: AuditActor,
  entry: AuditEntry,
): Promise<void> {
  let before: Prisma.InputJsonValue | undefined;
  let after: Prisma.InputJsonValue | undefined;
  let meta: Prisma.InputJsonValue | undefined;
  try {
    before = toJson(entry.before);
    after = toJson(entry.after);
    meta = toJson(entry.meta);
  } catch {
    meta = { auditFormatError: true };
  }
  const isSystem = "system" in actor;
  await tx.auditLog.create({
    data: {
      tenantId: actor.tenantId,
      actorType: isSystem ? "SYSTEM" : "USER",
      actorUserId: isSystem ? null : actor.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      branchId: entry.branchId ?? null,
      before,
      after,
      meta,
      ipAddress: isSystem ? null : (actor.request?.ip ?? null),
      userAgent: isSystem
        ? null
        : (actor.request?.userAgent?.slice(0, 500) ?? null),
    },
  });
}

export type AuditFilters = {
  action?: string;
  entityType?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
};

/** Tenant audit log (Owner/Admin via `audit.view`), newest first. */
export async function listAuditLogs(
  db: PrismaClient,
  ctx: AuthContext,
  filters: AuditFilters,
) {
  requirePermission(ctx, "audit.view");
  const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 100);
  const page = Math.max(filters.page ?? 1, 1);
  const where: Prisma.AuditLogWhereInput = {
    ...(filters.action ? { action: { startsWith: filters.action } } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [rows, total, actions] = await inOrder([
      tx.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      tx.auditLog.count({ where }),
      tx.auditLog.findMany({
        distinct: ["action"],
        select: { action: true },
        orderBy: { action: "asc" },
      }),
    ]);
    const userIds = [
      ...new Set(
        rows.map((r) => r.actorUserId).filter((id): id is string => !!id),
      ),
    ];
    const users = userIds.length
      ? await tx.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      rows: rows.map((row) => ({
        ...row,
        actor: row.actorUserId ? (byId.get(row.actorUserId) ?? null) : null,
      })),
      total,
      page,
      pageSize,
      actions: actions.map((a) => a.action),
    };
  });
}
