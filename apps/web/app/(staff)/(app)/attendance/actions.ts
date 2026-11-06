"use server";

import { correctAttendance } from "@gym/core/attendance";
import { formDataToObject } from "@gym/core/validation";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

/** Void or re-time a check-in (attendance.correct). Returns to the list with a notice. */
export async function correctAttendanceAction(form: FormData) {
  const id = z.uuid().parse(form.get("eventId"));
  const back = String(form.get("back") ?? "/attendance");
  const result = await runAction(async () =>
    correctAttendance(
      services().deps,
      await getAuthContext(),
      id,
      formDataToObject(form),
    ),
  );
  const target = back.startsWith("/attendance") ? back : "/attendance";
  const sep = target.includes("?") ? "&" : "?";
  redirect(
    `${target}${sep}${new URLSearchParams(
      result.ok
        ? { notice: "Check-in corrected." }
        : { error: result.error.message },
    )}`,
  );
}
