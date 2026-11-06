import type { Prisma, TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import { consentForTx } from "../messaging/contacts";
import { maskPhone } from "../messaging/rules";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";
import {
  compileLeadSegment,
  compileMemberSegment,
  describeSegment,
  segmentDefinitionSchema,
  type SegmentDefinition,
} from "./segment-dsl";

/** Audiences are tenant-wide and only for people who may launch campaigns. */
export const growthGuard = (deps: CoreDeps, ctx: AuthContext, write = false) =>
  guard(deps, ctx, {
    permission: "marketing.send",
    entitlement: "whatsapp.enabled",
    write,
  });

export const AUDIENCE_LIMIT = 50_000;

export type AudienceMember = {
  memberId: string | null;
  leadId: string | null;
  phone: string;
  name: string;
};

/** Everyone the definition matches right now (unique by phone; members win over leads). */
export async function audienceTx(
  tx: TenantTransaction,
  def: SegmentDefinition,
  ctx: { now: Date; timeZone: string },
  take = AUDIENCE_LIMIT,
): Promise<AudienceMember[]> {
  const seen = new Set<string>();
  const out: AudienceMember[] = [];
  if (def.entity === "MEMBER") {
    const rows = await tx.memberProfile.findMany({
      where: compileMemberSegment(def, ctx),
      select: { id: true, firstName: true, lastName: true, phone: true },
      orderBy: { joinedAt: "asc" },
      take,
    });
    for (const r of rows)
      if (r.phone && !seen.has(r.phone)) {
        seen.add(r.phone);
        out.push({
          memberId: r.id,
          leadId: null,
          phone: r.phone,
          name: [r.firstName, r.lastName].filter(Boolean).join(" "),
        });
      }
  } else {
    const rows = await tx.lead.findMany({
      where: compileLeadSegment(def, ctx),
      select: { id: true, firstName: true, lastName: true, phone: true },
      orderBy: { createdAt: "asc" },
      take,
    });
    for (const r of rows)
      if (r.phone && !seen.has(r.phone)) {
        seen.add(r.phone);
        out.push({
          memberId: null,
          leadId: r.id,
          phone: r.phone,
          name: [r.firstName, r.lastName].filter(Boolean).join(" "),
        });
      }
  }
  return out;
}

/** Is this member/lead in the segment now? (automation "segment" conditions) */
export async function inSegmentTx(
  tx: TenantTransaction,
  def: SegmentDefinition,
  subject: { memberId?: string | null; leadId?: string | null },
  ctx: { now: Date; timeZone: string },
): Promise<boolean> {
  if (def.entity === "MEMBER") {
    if (!subject.memberId) return false;
    return (
      (await tx.memberProfile.count({
        where: {
          AND: [{ id: subject.memberId }, compileMemberSegment(def, ctx)],
        },
      })) > 0
    );
  }
  if (!subject.leadId) return false;
  return (
    (await tx.lead.count({
      where: { AND: [{ id: subject.leadId }, compileLeadSegment(def, ctx)] },
    })) > 0
  );
}

/** How many we could reach with a MARKETING template: consent recorded and not opted out. */
export async function reachabilityTx(
  tx: TenantTransaction,
  audience: readonly AudienceMember[],
  sampleLimit = 5000,
) {
  const sample = audience.slice(0, sampleLimit);
  const suppressed = new Set(
    (
      await tx.suppressionRecord.findMany({
        where: {
          channel: "WHATSAPP",
          liftedAt: null,
          address: { in: sample.map((a) => a.phone) },
        },
        select: { address: true },
      })
    ).map((s) => s.address),
  );
  let marketing = 0;
  let service = 0;
  for (const a of sample) {
    if (suppressed.has(a.phone)) continue;
    const c = await consentForTx(tx, a);
    if (c.marketing) marketing++;
    if (c.service) service++;
  }
  const scale =
    audience.length && sample.length ? audience.length / sample.length : 1;
  return {
    suppressed: Math.round(suppressed.size * scale),
    marketingReachable: Math.round(marketing * scale),
    serviceReachable: Math.round(service * scale),
    estimated: sample.length < audience.length,
  };
}

const saveSchema = z.object({
  name: z.string().trim().min(2, "Name the audience.").max(80),
  definition: z.preprocess(
    (v) => (typeof v === "string" ? JSON.parse(v) : v),
    segmentDefinitionSchema,
  ),
});

export async function saveSegment(
  deps: CoreDeps,
  ctx: AuthContext,
  segmentId: string | null,
  raw: unknown,
) {
  await growthGuard(deps, ctx, true);
  const input = parseInput(saveSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const data = {
      name: input.name,
      entity: input.definition.entity,
      definition: input.definition as unknown as Prisma.InputJsonValue,
    };
    if (segmentId) {
      const existing = await tx.segment.findUnique({
        where: { id: segmentId },
      });
      if (!existing || existing.archivedAt)
        throw new AppError("NOT_FOUND", "Audience not found.");
      await tx.segment.update({ where: { id: segmentId }, data });
      await recordAudit(tx, ctx, {
        action: "segment.updated",
        entityType: "Segment",
        entityId: segmentId,
        after: { name: input.name, definition: input.definition },
      });
      return { id: segmentId };
    }
    const row = await tx.segment.create({
      data: { tenantId: ctx.tenantId, createdById: ctx.userId, ...data },
    });
    await recordAudit(tx, ctx, {
      action: "segment.created",
      entityType: "Segment",
      entityId: row.id,
      after: { name: input.name, definition: input.definition },
    });
    return { id: row.id };
  });
}

export async function archiveSegment(
  deps: CoreDeps,
  ctx: AuthContext,
  segmentId: string,
) {
  await growthGuard(deps, ctx, true);
  return inTenant(deps, ctx, async (tx) => {
    const inUse = await tx.campaign.count({
      where: { segmentId, sendStatus: { in: ["SCHEDULED", "SENDING"] } },
    });
    if (inUse)
      throw new AppError(
        "CONFLICT",
        "A scheduled or sending campaign uses this audience.",
      );
    await tx.segment.update({
      where: { id: segmentId },
      data: { archivedAt: nowOf(deps) },
    });
    await recordAudit(tx, ctx, {
      action: "segment.archived",
      entityType: "Segment",
      entityId: segmentId,
    });
  });
}

export async function listSegments(deps: CoreDeps, ctx: AuthContext) {
  await growthGuard(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.segment.findMany({
      where: { archivedAt: null },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((r) => {
      const def = segmentDefinitionSchema.safeParse(r.definition);
      return {
        ...r,
        summary: def.success ? describeSegment(def.data) : "Invalid definition",
      };
    });
  });
}

export async function getSegment(
  deps: CoreDeps,
  ctx: AuthContext,
  segmentId: string,
) {
  await growthGuard(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    const r = await tx.segment.findUnique({ where: { id: segmentId } });
    if (!r || r.archivedAt)
      throw new AppError("NOT_FOUND", "Audience not found.");
    return { ...r, definition: segmentDefinitionSchema.parse(r.definition) };
  });
}

/** Builder preview: count, how many we may market to, and a few names (numbers masked). */
export async function previewSegment(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await growthGuard(deps, ctx);
  const def = parseInput(
    z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      segmentDefinitionSchema,
    ),
    raw,
  );
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const audience = await audienceTx(tx, def, { now, timeZone: ctx.timezone });
    const reach = await reachabilityTx(tx, audience, 2000);
    return {
      count: audience.length,
      capped: audience.length >= AUDIENCE_LIMIT,
      ...reach,
      summary: describeSegment(def),
      sample: audience.slice(0, 10).map((a) => ({
        name: a.name,
        phone: maskPhone(a.phone),
        memberId: a.memberId,
        leadId: a.leadId,
      })),
    };
  });
}

/** Choices for the audience builder (ids and names only). */
export async function segmentBuilderOptions(deps: CoreDeps, ctx: AuthContext) {
  await growthGuard(deps, ctx);
  return inTenant(deps, ctx, async (tx) => ({
    branches: await tx.branch.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    plans: await tx.membershipPlan.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    stages: await tx.leadStage.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true },
      orderBy: { position: "asc" },
    }),
    sources: await tx.leadSource.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    campaigns: await tx.campaign.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  }));
}
