"use server";

import {
  createCoupon,
  createPlan,
  setCouponArchived,
  setPlanArchived,
  updatePlan,
} from "@gym/core/plans";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

export async function createPlanAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () =>
    createPlan(services().deps, await getAuthContext(), formDataToObject(form)),
  );
  if (!result.ok) return result;
  redirect(
    `/plans?notice=${encodeURIComponent(`Plan ${result.data.name} created.`)}`,
  );
}

export async function updatePlanAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const id = z.uuid().parse(form.get("planId"));
  const result = await runAction(async () =>
    updatePlan(
      services().deps,
      await getAuthContext(),
      id,
      formDataToObject(form),
    ),
  );
  if (!result.ok) return result;
  const notice = result.data.newVersion
    ? `Saved as version ${result.data.plan.version}. Members on earlier versions keep their terms.`
    : "Plan saved.";
  redirect(`/plans?notice=${encodeURIComponent(notice)}`);
}

export async function archivePlanAction(form: FormData) {
  const id = z.uuid().parse(form.get("planId"));
  const archived = form.get("archived") === "true";
  const result = await runAction(async () =>
    setPlanArchived(services().deps, await getAuthContext(), id, archived),
  );
  redirect(
    `/plans?${new URLSearchParams(result.ok ? { notice: archived ? "Plan archived." : "Plan restored." } : { error: result.error.message })}`,
  );
}

export async function createCouponAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      createCoupon(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Coupon created.",
  );
}

export async function archiveCouponAction(form: FormData) {
  const id = z.uuid().parse(form.get("couponId"));
  const archived = form.get("archived") === "true";
  const result = await runAction(async () =>
    setCouponArchived(services().deps, await getAuthContext(), id, archived),
  );
  redirect(
    `/plans/coupons?${new URLSearchParams(result.ok ? { notice: archived ? "Coupon archived." : "Coupon restored." } : { error: result.error.message })}`,
  );
}
