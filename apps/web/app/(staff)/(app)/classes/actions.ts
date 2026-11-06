"use server";

import {
  addToWaitlistForMember,
  archiveClassTemplate,
  bookableMembers,
  bookForMember,
  cancelBookingAsStaff,
  cancelClassSession,
  createCategory,
  createClassSession,
  createClassTemplate,
  createRoom,
  markBookingAttendance,
  removeFromWaitlist,
  updateClassSession,
  updateClassTemplate,
} from "@gym/core/classes";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

/** FormData → object, keeping repeated fields (checkbox groups) as arrays. */
function formObject(form: FormData) {
  const out: Record<string, unknown> = formDataToObject(form);
  for (const key of ["byDays", "eligiblePlanCodes"]) {
    const all = form.getAll(key).map(String).filter(Boolean);
    out[key] = all;
  }
  return out;
}

function flash(path: string, result: { ok: boolean; message: string }): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(
    `${path}${sep}${new URLSearchParams({ [result.ok ? "notice" : "error"]: result.message })}`,
  );
}

function summary(r: {
  created: number;
  updated: number;
  removed: number;
  flagged: number;
  conflicts: unknown[];
}) {
  const parts = [`${r.created} new session${r.created === 1 ? "" : "s"}`];
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.removed) parts.push(`${r.removed} removed`);
  if (r.flagged)
    parts.push(
      `${r.flagged} with bookings kept as they were (marked for you to check)`,
    );
  if (r.conflicts.length)
    parts.push(`${r.conflicts.length} with a trainer/room conflict (marked)`);
  return parts.join(", ");
}

export async function createTemplateAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () =>
    createClassTemplate(
      services().deps,
      await getAuthContext(),
      formObject(form),
    ),
  );
  if (!result.ok) return result;
  flash("/classes/templates", {
    ok: true,
    message: `${result.data.template.name} saved: ${summary(result.data)}.`,
  });
}

export async function updateTemplateAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const id = z.uuid().parse(form.get("templateId"));
  const result = await runAction(async () =>
    updateClassTemplate(
      services().deps,
      await getAuthContext(),
      id,
      formObject(form),
    ),
  );
  if (!result.ok) return result;
  flash("/classes/templates", {
    ok: true,
    message: `${result.data.template.name} saved: ${summary(result.data)}.`,
  });
}

export async function archiveTemplateAction(form: FormData) {
  const id = z.uuid().parse(form.get("templateId"));
  const result = await runAction(async () =>
    archiveClassTemplate(services().deps, await getAuthContext(), id),
  );
  flash(
    "/classes/templates",
    result.ok
      ? {
          ok: true,
          message: `Class archived. ${result.data.removed} future session(s) removed${result.data.flagged ? `; ${result.data.flagged} with bookings left for you to cancel` : ""}.`,
        }
      : { ok: false, message: result.error.message },
  );
}

export async function createSessionAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () =>
    createClassSession(
      services().deps,
      await getAuthContext(),
      formObject(form),
    ),
  );
  if (!result.ok) return result;
  redirect(
    `/classes/${result.data.id}?notice=${encodeURIComponent("Class created.")}`,
  );
}

export async function updateSessionAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const id = z.uuid().parse(form.get("sessionId"));
  return formAction(
    async () =>
      updateClassSession(
        services().deps,
        await getAuthContext(),
        id,
        formObject(form),
      ),
    "Class updated.",
  );
}

export async function cancelSessionAction(form: FormData) {
  const id = z.uuid().parse(form.get("sessionId"));
  const result = await runAction(async () =>
    cancelClassSession(services().deps, await getAuthContext(), id, {
      reason: form.get("reason"),
    }),
  );
  flash(
    `/classes/${id}`,
    result.ok
      ? {
          ok: true,
          message: `Class cancelled. ${result.data.bookingsCancelled} member(s) told and credits returned.`,
        }
      : { ok: false, message: result.error.message },
  );
}

export async function bookMemberAction(form: FormData) {
  const sessionId = z.uuid().parse(form.get("sessionId"));
  const waitlist = form.get("waitlist") === "1";
  const input = { sessionId, memberId: form.get("memberId") };
  const result = await runAction(async () =>
    waitlist
      ? addToWaitlistForMember(services().deps, await getAuthContext(), input)
      : bookForMember(services().deps, await getAuthContext(), input),
  );
  flash(
    `/classes/${sessionId}`,
    result.ok
      ? { ok: true, message: waitlist ? "Added to the waitlist." : "Booked." }
      : { ok: false, message: result.error.message },
  );
}

export async function staffCancelBookingAction(form: FormData) {
  const sessionId = z.uuid().parse(form.get("sessionId"));
  const bookingId = z.uuid().parse(form.get("bookingId"));
  const result = await runAction(async () =>
    cancelBookingAsStaff(
      services().deps,
      await getAuthContext(),
      bookingId,
      String(form.get("reason") ?? ""),
    ),
  );
  flash(
    `/classes/${sessionId}`,
    result.ok
      ? {
          ok: true,
          message: `Booking cancelled${result.data.promoted ? `; ${result.data.promoted} moved up from the waitlist` : ""}.`,
        }
      : { ok: false, message: result.error.message },
  );
}

export async function removeWaitlistAction(form: FormData) {
  const sessionId = z.uuid().parse(form.get("sessionId"));
  const entryId = z.uuid().parse(form.get("entryId"));
  const result = await runAction(async () =>
    removeFromWaitlist(services().deps, await getAuthContext(), entryId),
  );
  flash(
    `/classes/${sessionId}`,
    result.ok
      ? { ok: true, message: "Removed from the waitlist." }
      : { ok: false, message: result.error.message },
  );
}

export async function markAttendanceAction(form: FormData) {
  const sessionId = z.uuid().parse(form.get("sessionId"));
  const bookingId = z.uuid().parse(form.get("bookingId"));
  const result = await runAction(async () =>
    markBookingAttendance(services().deps, await getAuthContext(), bookingId, {
      status: form.get("status"),
    }),
  );
  flash(
    `/classes/${sessionId}`,
    result.ok
      ? { ok: true, message: "Attendance saved." }
      : { ok: false, message: result.error.message },
  );
}

export async function searchBookableAction(query: string) {
  return runAction(async () =>
    bookableMembers(
      services().deps,
      await getAuthContext(),
      String(query).slice(0, 60),
    ),
  );
}

export async function createCategoryAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      createCategory(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Category added.",
  );
}

export async function createRoomAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      createRoom(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Room added.",
  );
}
