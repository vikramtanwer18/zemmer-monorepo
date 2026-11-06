"use server";

import {
  archiveAnnouncement,
  decidePerk,
  publishAnnouncement,
  saveAchievement,
  saveChallenge,
  savePerk,
  saveRewardSettings,
  setChallengeStatus,
} from "@gym/core/engagement";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

const go = (path: string, params: Record<string, string>) =>
  redirect(`${path}?${new URLSearchParams(params)}`);

export async function publishAnnouncementAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const res = await runAction(async () =>
    publishAnnouncement(
      services().deps,
      await getAuthContext(),
      formDataToObject(form),
    ),
  );
  if (!res.ok) return res;
  return {
    ok: true,
    message: `Posted. ${res.data.notified} member(s) notified in the app.`,
  };
}

export async function archiveAnnouncementAction(form: FormData) {
  const res = await runAction(async () =>
    archiveAnnouncement(
      services().deps,
      await getAuthContext(),
      String(form.get("id")),
    ),
  );
  go(
    "/engagement",
    res.ok ? { notice: "Taken down." } : { error: res.error.message },
  );
}

export async function saveChallengeAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      saveChallenge(
        services().deps,
        await getAuthContext(),
        null,
        formDataToObject(form),
      ),
    "Saved as a draft. Start it when ready.",
  );
}

export async function challengeStatusAction(form: FormData) {
  const res = await runAction(async () =>
    setChallengeStatus(
      services().deps,
      await getAuthContext(),
      String(form.get("id")),
      String(form.get("status")) as "ACTIVE" | "ENDED" | "CANCELLED",
    ),
  );
  go(
    "/engagement/challenges",
    res.ok ? { notice: "Updated." } : { error: res.error.message },
  );
}

const TRIGGERS = [
  "VISIT",
  "WORKOUT_COMPLETED",
  "REFERRAL_CONVERTED",
  "CHALLENGE_COMPLETED",
  "ACHIEVEMENT",
] as const;

export async function rewardSettingsAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  const rules = Object.fromEntries(
    TRIGGERS.map((t) => [
      t,
      {
        points: raw[`points_${t}`] ?? "0",
        enabled: raw[`enabled_${t}`] === "on",
      },
    ]),
  );
  return formAction(
    async () =>
      saveRewardSettings(services().deps, await getAuthContext(), {
        rewardPointValueMinor: Math.round(
          Number(raw.pointValueRupees ?? "0") * 100,
        ),
        rewardMinRedeemPoints: raw.rewardMinRedeemPoints,
        rewardVisitWeeklyCap: raw.rewardVisitWeeklyCap,
        streakVisitsPerWeek: raw.streakVisitsPerWeek,
        streakGraceDays: raw.streakGraceDays,
        rules,
      }),
    "Saved.",
  );
}

export async function achievementAction(form: FormData) {
  const res = await runAction(async () =>
    saveAchievement(
      services().deps,
      await getAuthContext(),
      String(form.get("id")),
      { points: form.get("points"), enabled: form.get("enabled") === "on" },
    ),
  );
  go(
    "/engagement/rewards",
    res.ok ? { notice: "Milestone updated." } : { error: res.error.message },
  );
}

export async function perkAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const raw = formDataToObject(form) as Record<string, string>;
  return formAction(
    async () =>
      savePerk(services().deps, await getAuthContext(), raw.perkId || null, {
        ...raw,
        active: raw.active !== "off",
      }),
    "Saved.",
  );
}

export async function decidePerkAction(form: FormData) {
  const res = await runAction(async () =>
    decidePerk(
      services().deps,
      await getAuthContext(),
      String(form.get("id")),
      {
        fulfil: form.get("decision") === "fulfil",
        note: String(form.get("note") ?? ""),
      },
    ),
  );
  go(
    "/engagement/redemptions",
    res.ok
      ? {
          notice:
            form.get("decision") === "fulfil"
              ? "Marked as handed over."
              : "Refused; the points went back.",
        }
      : { error: res.error.message },
  );
}
