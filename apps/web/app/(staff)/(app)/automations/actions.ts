"use server";

import {
  archiveWorkflow,
  cancelExecution,
  decideApproval,
  installLibraryWorkflow,
  saveWorkflow,
  setWorkflowEnabled,
} from "@gym/core/automation";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

const go = (path: string, params: Record<string, string>) =>
  redirect(`${path}?${new URLSearchParams(params)}`);

export async function installAction(form: FormData) {
  const result = await runAction(async () =>
    installLibraryWorkflow(
      services().deps,
      await getAuthContext(),
      String(form.get("key")),
    ),
  );
  if (result.ok)
    go(`/automations/${result.data.id}`, {
      notice: [
        "Installed, switched off. Check it, dry-run it, then switch it on.",
        ...result.data.warnings,
      ].join(" "),
    });
  go("/automations", { error: result.ok ? "" : result.error.message });
}

export async function toggleAction(form: FormData) {
  const id = String(form.get("workflowId"));
  const enabled = form.get("enabled") === "true";
  const result = await runAction(async () =>
    setWorkflowEnabled(services().deps, await getAuthContext(), id, enabled),
  );
  go(
    `/automations/${id}`,
    result.ok
      ? {
          notice: enabled
            ? "Switched on. New triggers start it from now."
            : "Switched off. Running ones stop at their next step.",
        }
      : { error: result.error.message },
  );
}

export async function archiveAction(form: FormData) {
  const result = await runAction(async () =>
    archiveWorkflow(
      services().deps,
      await getAuthContext(),
      String(form.get("workflowId")),
    ),
  );
  go(
    "/automations",
    result.ok ? { notice: "Archived." } : { error: result.error.message },
  );
}

/** Saves a new version from the editor (name + definition JSON). */
export async function saveWorkflowAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  let definition: unknown;
  try {
    definition = JSON.parse(raw.definition ?? "");
  } catch {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "The definition isn't valid JSON.",
        fields: { definition: ["Not valid JSON."] },
      },
    };
  }
  const result = await runAction(async () =>
    saveWorkflow(
      services().deps,
      await getAuthContext(),
      raw.workflowId || null,
      { name: raw.name, definition },
    ),
  );
  if (!result.ok) return result;
  revalidatePath("/automations", "layout");
  const note = result.data.disabled
    ? " It was switched off because the new version can't run yet."
    : "";
  if (!raw.workflowId)
    redirect(
      `/automations/${result.data.id}?${new URLSearchParams({ notice: `Saved as version ${result.data.version}.${note}` })}`,
    );
  return {
    ok: true,
    message: `Saved as version ${result.data.version}.${note}${result.data.problems.length ? ` Before switching on: ${result.data.problems.join(" ")}` : ""}`,
  };
}

export async function decideAction(form: FormData) {
  const id = String(form.get("executionId"));
  const approve = form.get("decision") === "approve";
  const result = await runAction(async () =>
    decideApproval(services().deps, await getAuthContext(), id, {
      approve,
      note: String(form.get("note") ?? "") || undefined,
    }),
  );
  go(
    "/automations/approvals",
    result.ok
      ? {
          notice: approve
            ? "Approved: it continues now."
            : "Rejected: it stops here.",
        }
      : { error: result.error.message },
  );
}

export async function stopExecutionAction(form: FormData) {
  const workflowId = String(form.get("workflowId"));
  const result = await runAction(async () =>
    cancelExecution(
      services().deps,
      await getAuthContext(),
      String(form.get("executionId")),
    ),
  );
  go(
    `/automations/${workflowId}`,
    result.ok ? { notice: "Stopped." } : { error: result.error.message },
  );
}
