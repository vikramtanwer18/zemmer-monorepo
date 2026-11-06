"use server";

import {
  askCopilot,
  type CopilotAnswer,
  type TaskProposal,
} from "@gym/core/copilot";
import { createTask } from "@gym/core/crm";
import type { ActionResult } from "@gym/core/errors";
import { runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

/** One Copilot question. The conversation lives only in the browser; nothing is stored server-side. */
export async function askCopilotAction(input: {
  question: string;
  history: { role: "user" | "assistant"; content: string }[];
}): Promise<ActionResult<CopilotAnswer>> {
  return runAction(async () => {
    const { deps, ai } = services();
    return askCopilot(deps, ai, await getAuthContext(), input);
  });
}

/**
 * The user confirmed a task the Copilot proposed: create it through the normal, permission-checked
 * task service (tasks.manage, lead/member must be in this gym). The Copilot itself never writes.
 */
export async function createProposedTaskAction(
  p: TaskProposal,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const task = await createTask(services().deps, await getAuthContext(), {
      title: p.title,
      notes: p.notes ?? undefined,
      due: p.due,
      kind: "FOLLOW_UP",
      ...(p.leadId ? { leadId: p.leadId } : {}),
      ...(p.memberId ? { memberId: p.memberId } : {}),
    });
    return { id: task.id };
  });
}
