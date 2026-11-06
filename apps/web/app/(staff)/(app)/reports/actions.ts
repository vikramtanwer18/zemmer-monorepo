"use server";

import { enqueue } from "@gym/core/jobs";
import { isReportKey, requestReportExport } from "@gym/core/reports";
import { redirect } from "next/navigation";
import { scopeFromParams } from "@/components/scope-filters";
import { runAction } from "@/lib/action";
import { getRedis } from "@/lib/queue";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

/** Queues a CSV/XLSX export of the report as filtered on screen (reports.export, audited). */
export async function exportReportAction(form: FormData): Promise<never> {
  const report = String(form.get("report") ?? "");
  const back = isReportKey(report) ? `/reports/${report}` : "/reports";
  const params = Object.fromEntries(
    [...form.entries()].map(([k, v]) => [k, String(v)]),
  );
  const query = new URLSearchParams(
    Object.entries(params).filter(
      ([k, v]) => ["preset", "from", "to", "branchId"].includes(k) && v !== "",
    ),
  ).toString();
  const result = await runAction(async () => {
    const ctx = await getAuthContext();
    const job = await requestReportExport(services().deps, ctx, {
      report,
      format: params.format === "xlsx" ? "xlsx" : "csv",
      scope: scopeFromParams(params),
    });
    await enqueue(getRedis(), "data", "reports.export", {
      tenantId: ctx.tenantId,
      actor: { type: "user", id: ctx.userId },
      idempotencyKey: `report-export-${job.id}`,
      data: { dataJobId: job.id },
    });
  });
  const flash: Record<string, string> = result.ok
    ? {
        notice:
          "Export started. It appears under Exports below when it's ready (usually seconds).",
      }
    : { error: result.error.message };
  redirect(
    `${back}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(query)), ...flash })}#exports`,
  );
}
