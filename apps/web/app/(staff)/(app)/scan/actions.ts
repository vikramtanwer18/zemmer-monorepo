"use server";

import {
  manualCheckIn,
  searchMembersForCheckIn,
  validateScan,
  type ScanResult,
} from "@gym/core/attendance";
import { isTrialQr, scanTrialPass } from "@gym/core/crm";
import type { ActionResult } from "@gym/core/errors";
import { runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

/** One scan (camera, USB/Bluetooth scanner, or typed). Every scan is recorded by the service. */
export async function scanAction(input: {
  payload: string;
  branchId: string;
  deviceId?: string;
  type?: "CHECK_IN" | "CHECK_OUT";
}): Promise<ActionResult<ScanResult>> {
  return runAction(async () => {
    const ctx = await getAuthContext();
    // M5: a lead's temporary trial pass (GT1.…) checks them in for their trial.
    if (isTrialQr(input.payload)) {
      const trial = await scanTrialPass(services().deps, ctx, {
        code: input.payload,
        branchId: input.branchId,
      });
      return {
        result: trial.ok ? "ACCEPTED" : "REJECTED",
        type: "CHECK_IN",
        code: null,
        message: trial.ok
          ? `Trial: ${trial.name} (booked ${trial.when}). Welcome them!`
          : trial.reason,
        eventId: "",
        occurredAt: new Date(),
        member: null,
        membership: null,
        warnings: [],
        overridable: false,
        markedClasses: 0,
      } satisfies ScanResult;
    }
    return validateScan(services().deps, ctx, {
      ...input,
      deviceId: input.deviceId || undefined,
    });
  });
}

export async function manualCheckInAction(input: {
  memberId: string;
  branchId: string;
  reason: string;
  override?: boolean;
  type?: "CHECK_IN" | "CHECK_OUT";
  deviceId?: string;
}): Promise<ActionResult<ScanResult>> {
  return runAction(async () =>
    manualCheckIn(services().deps, await getAuthContext(), {
      ...input,
      deviceId: input.deviceId || undefined,
    }),
  );
}

export async function searchMembersAction(query: string) {
  return runAction(async () =>
    searchMembersForCheckIn(
      services().deps,
      await getAuthContext(),
      String(query).slice(0, 60),
    ),
  );
}
