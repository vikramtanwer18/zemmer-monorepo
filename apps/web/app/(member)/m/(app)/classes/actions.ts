"use server";

import {
  bookMyClass,
  cancelMyBooking,
  joinMyWaitlist,
  leaveMyWaitlist,
} from "@gym/core/classes";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction } from "@/lib/action";
import { getMemberContext } from "@/lib/member-session";
import { services } from "@/lib/services";

function back(form: FormData, result: { ok: boolean; message: string }) {
  const day = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .safeParse(form.get("day"));
  const params = new URLSearchParams({
    [result.ok ? "notice" : "error"]: result.message,
    ...(day.success ? { day: day.data } : {}),
  });
  redirect(`/m/classes?${params}`);
}

export async function bookClassAction(form: FormData) {
  const sessionId = String(form.get("sessionId") ?? "");
  const res = await runAction(async () =>
    bookMyClass(services().deps, await getMemberContext(), { sessionId }),
  );
  back(
    form,
    res.ok
      ? { ok: true, message: "Booked. See you there!" }
      : { ok: false, message: res.error.message },
  );
}

export async function joinWaitlistAction(form: FormData) {
  const sessionId = String(form.get("sessionId") ?? "");
  const res = await runAction(async () =>
    joinMyWaitlist(services().deps, await getMemberContext(), { sessionId }),
  );
  back(
    form,
    res.ok
      ? {
          ok: true,
          message: `You're number ${res.data.place} on the waitlist. We'll book you automatically if a place opens.`,
        }
      : { ok: false, message: res.error.message },
  );
}

export async function cancelBookingAction(form: FormData) {
  const id = z.uuid().safeParse(form.get("bookingId"));
  if (!id.success)
    return back(form, { ok: false, message: "Booking not found." });
  const res = await runAction(async () =>
    cancelMyBooking(services().deps, await getMemberContext(), id.data),
  );
  back(
    form,
    res.ok
      ? {
          ok: true,
          message: res.data.late
            ? res.data.creditReturned
              ? "Cancelled (late)."
              : "Cancelled. It was after the cancellation cutoff, so the class credit is used."
            : "Cancelled. Your place has been released.",
        }
      : { ok: false, message: res.error.message },
  );
}

export async function leaveWaitlistAction(form: FormData) {
  const id = z.uuid().safeParse(form.get("entryId"));
  if (!id.success) return back(form, { ok: false, message: "Not found." });
  const res = await runAction(async () =>
    leaveMyWaitlist(services().deps, await getMemberContext(), id.data),
  );
  back(
    form,
    res.ok
      ? { ok: true, message: "You've left the waitlist." }
      : { ok: false, message: res.error.message },
  );
}
