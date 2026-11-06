import { hasPermission } from "@gym/core/authz";
import { withTenant } from "@gym/db";
import { services } from "@/lib/services";
import { getSessionState } from "@/lib/session";

const DOWNLOADED = {
  MEMBER_EXPORT: "member.export_downloaded",
  LEAD_EXPORT: "leads.export_downloaded",
  REPORT_EXPORT: "reports.export_downloaded",
} as const;

/**
 * Downloads a finished export (members.export / leads.export / reports.export), same tenant,
 * within 24 hours. Report exports can only be downloaded by the person who asked for them. Audited.
 */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const state = await getSessionState();
  if (state.kind !== "ready")
    return new Response("Sign in first", { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return new Response("Not found", { status: 404 });
  const allowed = {
    MEMBER_EXPORT: hasPermission(state.ctx, "members.export"),
    LEAD_EXPORT: hasPermission(state.ctx, "leads.export"),
    REPORT_EXPORT: hasPermission(state.ctx, "reports.export"),
  };
  const { db, storage } = services();
  const file = await withTenant(db, state.ctx.tenantId, async (tx) => {
    const job = await tx.dataJob.findUnique({ where: { id } });
    if (
      !job ||
      (job.kind !== "MEMBER_EXPORT" &&
        job.kind !== "LEAD_EXPORT" &&
        job.kind !== "REPORT_EXPORT") ||
      !allowed[job.kind] ||
      (job.kind === "REPORT_EXPORT" && job.createdById !== state.ctx.userId) ||
      !job.resultFileId
    )
      return null;
    const f = await tx.fileRecord.findUnique({
      where: { id: job.resultFileId },
    });
    if (!f || (f.expiresAt && f.expiresAt <= new Date())) return null;
    await tx.auditLog.create({
      data: {
        tenantId: state.ctx.tenantId,
        actorType: "USER",
        actorUserId: state.ctx.userId,
        action: DOWNLOADED[job.kind],
        entityType: "DataJob",
        entityId: id,
      },
    });
    return f;
  });
  if (!file)
    return new Response("This export has expired or doesn't exist.", {
      status: 404,
    });
  return Response.redirect(await storage.getUrl(file.key, 60), 302);
}
