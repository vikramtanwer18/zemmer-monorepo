"use server";

import {
  assignLead,
  bookTrial,
  cancelTask,
  cancelTrial,
  completeTask,
  convertLead,
  createLead,
  createTask,
  deleteView,
  logLeadActivity,
  markLeadLost,
  markTrial,
  moveLead,
  reopenLead,
  requestLeadExport,
  rescheduleTask,
  saveView,
  updateLead,
} from "@gym/core/crm";
import { AppError, isAppError } from "@gym/core/errors";
import { enqueue } from "@gym/core/jobs";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { getRedis } from "@/lib/queue";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

const uuid = (v: FormDataEntryValue | null) => z.uuid().parse(v);

/** Only our own pages as a return path. */
function backTo(form: FormData, fallback: string) {
  const v = String(form.get("back") ?? "");
  return /^\/(leads|tasks|members)(\/|\?|$)/.test(v) ? v : fallback;
}

function flash(path: string, ok: boolean, message: string): never {
  redirect(
    `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ [ok ? "notice" : "error"]: message })}`,
  );
}

async function run(
  form: FormData,
  fallback: string,
  fn: () => Promise<unknown>,
  notice: string,
): Promise<never> {
  const result = await runAction(fn);
  flash(
    backTo(form, fallback),
    result.ok,
    result.ok ? notice : result.error.message,
  );
}

type Dupes = {
  leads: { name: string; stage: string; status: string }[];
  members: { name: string; memberCode: string }[];
};

export async function createLeadAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  let id: string | null = null;
  const result = await formAction(async () => {
    try {
      id = (
        await createLead(
          services().deps,
          await getAuthContext(),
          formDataToObject(form),
        )
      ).id;
    } catch (err) {
      // Name the matches so staff can decide (they can open them from search).
      if (
        isAppError(err) &&
        err.code === "CONFLICT" &&
        (err.details as { duplicates?: Dupes })?.duplicates
      ) {
        const d = (err.details as { duplicates: Dupes }).duplicates;
        const found = [
          ...d.leads.map(
            (l) =>
              `${l.name} (lead, ${l.status === "OPEN" ? l.stage : l.status.toLowerCase()})`,
          ),
          ...d.members.map((m) => `${m.name} (member ${m.memberCode})`),
        ];
        throw new AppError(
          "CONFLICT",
          `Already here: ${found.join(", ")}. Search for them, or tick "Add anyway".`,
          {
            fields: err.fields,
          },
        );
      }
      throw err;
    }
  });
  if (result.ok && id)
    redirect(
      `/leads/${id}?notice=${encodeURIComponent("Lead added. A first-contact task is waiting.")}`,
    );
  return result;
}

export async function updateLeadAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const id = uuid(form.get("leadId"));
  return formAction(
    async () =>
      updateLead(
        services().deps,
        await getAuthContext(),
        id,
        formDataToObject(form),
      ),
    "Saved.",
  );
}

export async function moveLeadAction(form: FormData) {
  const id = uuid(form.get("leadId"));
  return run(
    form,
    `/leads/${id}`,
    async () =>
      moveLead(services().deps, await getAuthContext(), id, {
        stageId: form.get("stageId"),
      }),
    "Stage changed.",
  );
}

/** Board drag-and-drop (client): returns a result instead of redirecting. */
export async function moveLeadFromBoard(leadId: string, stageId: string) {
  return runAction(async () =>
    moveLead(services().deps, await getAuthContext(), z.uuid().parse(leadId), {
      stageId,
    }),
  );
}

export async function assignLeadAction(form: FormData) {
  const id = uuid(form.get("leadId"));
  return run(
    form,
    `/leads/${id}`,
    async () =>
      assignLead(services().deps, await getAuthContext(), id, {
        ownerUserId: form.get("ownerUserId"),
      }),
    "Owner changed.",
  );
}

export async function logActivityAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const id = uuid(form.get("leadId"));
  return formAction(
    async () =>
      logLeadActivity(
        services().deps,
        await getAuthContext(),
        id,
        formDataToObject(form),
      ),
    "Logged.",
  );
}

export async function markLostAction(form: FormData) {
  const id = uuid(form.get("leadId"));
  return run(
    form,
    `/leads/${id}`,
    async () =>
      markLeadLost(
        services().deps,
        await getAuthContext(),
        id,
        formDataToObject(form),
      ),
    "Marked as lost.",
  );
}

export async function reopenLeadAction(form: FormData) {
  const id = uuid(form.get("leadId"));
  return run(
    form,
    `/leads/${id}`,
    async () => reopenLead(services().deps, await getAuthContext(), id),
    "Reopened.",
  );
}

/** Step 1 of conversion; then straight to the sell-membership page with the lead attached. */
export async function convertLeadAction(form: FormData) {
  const id = uuid(form.get("leadId"));
  const result = await runAction(async () =>
    convertLead(
      services().deps,
      await getAuthContext(),
      id,
      formDataToObject(form),
    ),
  );
  if (!result.ok) flash(`/leads/${id}`, false, result.error.message);
  redirect(`/members/${result.data.memberId}/sell?leadId=${id}`);
}

export async function bookTrialAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const id = uuid(form.get("leadId"));
  return formAction(
    async () =>
      bookTrial(
        services().deps,
        await getAuthContext(),
        id,
        formDataToObject(form),
      ),
    "Trial booked.",
  );
}

export async function cancelTrialAction(form: FormData) {
  const id = uuid(form.get("trialId"));
  return run(
    form,
    "/leads/trials",
    async () => cancelTrial(services().deps, await getAuthContext(), id),
    "Trial cancelled.",
  );
}

export async function markTrialAction(form: FormData) {
  const id = uuid(form.get("trialId"));
  const outcome = String(form.get("outcome"));
  return run(
    form,
    "/leads/trials",
    async () =>
      markTrial(services().deps, await getAuthContext(), id, { outcome }),
    outcome === "ATTENDED"
      ? "Marked as attended."
      : "Marked as no-show. A call-back task was added.",
  );
}

export async function createTaskAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      createTask(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Task added.",
  );
}

export async function completeTaskAction(form: FormData) {
  const id = uuid(form.get("taskId"));
  return run(
    form,
    "/tasks",
    async () =>
      completeTask(services().deps, await getAuthContext(), id, {
        outcome: form.get("outcome") ?? "",
      }),
    "Task done.",
  );
}

export async function cancelTaskAction(form: FormData) {
  const id = uuid(form.get("taskId"));
  return run(
    form,
    "/tasks",
    async () => cancelTask(services().deps, await getAuthContext(), id),
    "Task cancelled.",
  );
}

export async function rescheduleTaskAction(form: FormData) {
  const id = uuid(form.get("taskId"));
  return run(
    form,
    "/tasks",
    async () =>
      rescheduleTask(services().deps, await getAuthContext(), id, {
        due: form.get("due"),
      }),
    "Task moved.",
  );
}

export async function saveViewAction(form: FormData) {
  const filters = Object.fromEntries(
    new URLSearchParams(String(form.get("query") ?? "")).entries(),
  );
  return run(
    form,
    "/leads",
    async () =>
      saveView(services().deps, await getAuthContext(), {
        name: form.get("name"),
        filters,
        shared: form.get("shared") ?? "",
      }),
    "View saved.",
  );
}

export async function deleteViewAction(form: FormData) {
  const id = uuid(form.get("viewId"));
  return run(
    form,
    "/leads",
    async () => deleteView(services().deps, await getAuthContext(), id),
    "View removed.",
  );
}

export async function exportLeadsAction(form: FormData) {
  const filters = Object.fromEntries(
    new URLSearchParams(String(form.get("query") ?? "")).entries(),
  );
  return run(
    form,
    "/leads/import",
    async () => {
      const ctx = await getAuthContext();
      const job = await requestLeadExport(services().deps, ctx, filters);
      await enqueue(getRedis(), "data", "leads.export", {
        tenantId: ctx.tenantId,
        actor: { type: "user", id: ctx.userId },
        idempotencyKey: `lead-export-${job.id}`,
        data: { dataJobId: job.id },
      });
    },
    "Export started. It appears on Import / export when ready (usually seconds).",
  );
}
