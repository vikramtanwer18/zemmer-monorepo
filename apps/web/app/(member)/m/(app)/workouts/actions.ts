"use server";

import {
  joinChallenge,
  leaveChallenge,
  redeemPointsForCredit,
  requestPerk,
} from "@gym/core/engagement";
import {
  addMyGoal,
  completeWorkout,
  deleteSet,
  logSet,
  recordMyMeasurement,
  setMyGoalStatus,
  setMyHealthConsent,
  startWorkout,
} from "@gym/core/fitness";
import {
  correctFoodLog,
  deleteFoodLog,
  logFood,
  logWater,
  undoLastWater,
} from "@gym/core/nutrition";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, runAction } from "@/lib/action";
import { getMemberContext } from "@/lib/member-session";
import { services } from "@/lib/services";

/** Only our own member pages (no open redirect). */
const safe = (p: unknown, fallback: string) => {
  const s = typeof p === "string" ? p : "";
  return /^\/m\/[\w\-/?=&]*$/.test(s) ? s : fallback;
};
const go = (path: string, params: Record<string, string>) =>
  redirect(
    `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams(params)}`,
  );

export async function healthConsentAction(form: FormData) {
  const back = safe(form.get("back"), "/m/workouts");
  const res = await runAction(async () =>
    setMyHealthConsent(services().deps, await getMemberContext(), {
      granted: form.get("granted") === "on",
    }),
  );
  go(
    back,
    res.ok
      ? {
          notice:
            form.get("granted") === "on"
              ? "Thanks. You can start tracking now."
              : "Withdrawn. Nothing new is recorded and staff can't see it.",
        }
      : { error: res.error.message },
  );
}

// --- workouts ---------------------------------------------------------------------------------

export async function startWorkoutAction(form: FormData) {
  const res = await runAction(async () =>
    startWorkout(services().deps, await getMemberContext(), {
      dayKey: form.get("dayKey") ?? "",
    }),
  );
  if (res.ok) redirect(`/m/workouts/log/${res.data.id}`);
  go("/m/workouts", { error: res.error.message });
}

export async function logSetAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  return formAction(
    async () =>
      logSet(services().deps, await getMemberContext(), raw.logId ?? "", raw),
    "Saved.",
  );
}

export async function deleteSetAction(form: FormData) {
  const logId = String(form.get("logId"));
  const res = await runAction(async () =>
    deleteSet(
      services().deps,
      await getMemberContext(),
      String(form.get("setId")),
    ),
  );
  go(
    `/m/workouts/log/${logId}`,
    res.ok ? { notice: "Set removed." } : { error: res.error.message },
  );
}

export async function completeWorkoutAction(form: FormData) {
  const logId = String(form.get("logId"));
  const res = await runAction(async () =>
    completeWorkout(
      services().deps,
      await getMemberContext(),
      logId,
      formDataToObject(form),
    ),
  );
  if (!res.ok) go(`/m/workouts/log/${logId}`, { error: res.error.message });
  else {
    const prs = res.data.records.length;
    const pts = res.data.engagement.points;
    go(`/m/workouts/log/${logId}`, {
      notice: [
        "Workout done.",
        prs ? `${prs} personal record${prs > 1 ? "s" : ""}!` : "",
        pts ? `+${pts} points.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }
}

// --- progress ---------------------------------------------------------------------------------

export async function addGoalAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      addMyGoal(
        services().deps,
        await getMemberContext(),
        formDataToObject(form),
      ),
    "Goal added.",
  );
}

export async function goalStatusAction(form: FormData) {
  const status = String(form.get("status")) as
    "ACHIEVED" | "ABANDONED" | "ACTIVE";
  const res = await runAction(async () =>
    setMyGoalStatus(
      services().deps,
      await getMemberContext(),
      String(form.get("goalId")),
      status,
    ),
  );
  go(
    "/m/progress",
    res.ok ? { notice: "Updated." } : { error: res.error.message },
  );
}

export async function measurementAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  const metrics: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw))
    if (k.startsWith("m_") && v !== "") metrics[k.slice(2)] = v;
  return formAction(
    async () =>
      recordMyMeasurement(services().deps, await getMemberContext(), {
        metrics,
        notes: raw.notes ?? "",
      }),
    "Saved.",
  );
}

// --- nutrition --------------------------------------------------------------------------------

export async function logFoodAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form);
  const res = await runAction(async () =>
    logFood(services().deps, await getMemberContext(), raw),
  );
  if (!res.ok) return res;
  revalidatePath("/m/nutrition");
  return {
    ok: true,
    message: `Added: about ${Math.round(res.data.kcal)} kcal (estimate).`,
  };
}

export async function correctFoodAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  return formAction(
    async () =>
      correctFoodLog(
        services().deps,
        await getMemberContext(),
        raw.logId ?? "",
        raw,
      ),
    "Corrected.",
  );
}

export async function deleteFoodAction(form: FormData) {
  const res = await runAction(async () =>
    deleteFoodLog(
      services().deps,
      await getMemberContext(),
      String(form.get("logId")),
    ),
  );
  go(
    "/m/nutrition",
    res.ok ? { notice: "Removed." } : { error: res.error.message },
  );
}

export async function waterAction(form: FormData) {
  const undo = form.get("undo") === "1";
  const res = await runAction(async () => {
    const mctx = await getMemberContext();
    return undo
      ? undoLastWater(services().deps, mctx)
      : logWater(services().deps, mctx, { ml: form.get("ml") });
  });
  go("/m/nutrition", res.ok ? {} : { error: res.error.message });
}

// --- rewards & challenges ---------------------------------------------------------------------

export async function redeemCreditAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const res = await runAction(async () =>
    redeemPointsForCredit(
      services().deps,
      await getMemberContext(),
      formDataToObject(form),
    ),
  );
  if (!res.ok) return res;
  revalidatePath("/m/rewards");
  return {
    ok: true,
    message: `Done: ₹${(res.data.amountMinor / 100).toFixed(2)} added to your credit.`,
  };
}

export async function requestPerkAction(form: FormData) {
  const res = await runAction(async () =>
    requestPerk(
      services().deps,
      await getMemberContext(),
      String(form.get("perkId")),
    ),
  );
  go(
    "/m/rewards",
    res.ok
      ? { notice: "Requested. Collect it at the front desk." }
      : { error: res.error.message },
  );
}

export async function joinChallengeAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  return formAction(
    async () =>
      joinChallenge(
        services().deps,
        await getMemberContext(),
        raw.challengeId ?? "",
        raw,
      ),
    "You're in. Good luck!",
  );
}

export async function leaveChallengeAction(form: FormData) {
  const res = await runAction(async () =>
    leaveChallenge(
      services().deps,
      await getMemberContext(),
      String(form.get("challengeId")),
    ),
  );
  go(
    "/m/rewards",
    res.ok ? { notice: "Left the challenge." } : { error: res.error.message },
  );
}
