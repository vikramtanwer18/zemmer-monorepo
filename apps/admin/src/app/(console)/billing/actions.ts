"use server";

import {
  archiveAnnouncement,
  compSubscription,
  createAnnouncement,
  extendTrial,
  retryFailedJob,
  retryOutboxRow,
  setPlatformPaymentAccount,
  updateBillingSettings,
  updatePrice,
} from "@gym/core/saas-billing";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getPlatformContext } from "@/lib/session";

const uuid = (value: FormDataEntryValue | null) => z.uuid().parse(value);

/** A datetime-local value from the console, read as India time (the operator's timezone). */
function ist(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
  )
    return undefined;
  return `${value}:00+05:30`;
}

async function runAndReturn(
  path: string,
  fn: () => Promise<unknown>,
  notice: string,
): Promise<never> {
  const result = await runAction(fn);
  redirect(
    `${path}?${new URLSearchParams(result.ok ? { notice } : { error: result.error.message.slice(0, 200) })}`,
  );
}

export async function setPaymentAccountAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      setPlatformPaymentAccount(
        services().billing,
        await getPlatformContext(),
        formDataToObject(form),
      ),
    "Payment account saved and checked with Razorpay.",
  );
}

export async function updateBillingSettingsAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      updateBillingSettings(
        services().billing,
        await getPlatformContext(),
        formDataToObject(form),
      ),
    "Billing settings saved. New SaaS invoices use them.",
  );
}

export async function updatePriceAction(form: FormData) {
  return runAndReturn(
    "/billing/setup",
    async () =>
      updatePrice(
        services().billing,
        await getPlatformContext(),
        uuid(form.get("priceId")),
        {
          amount: form.get("amount"),
        },
      ),
    "Price updated. New checkouts use it; current subscribers keep their price.",
  );
}

export async function extendTrialAction(form: FormData) {
  return runAndReturn(
    "/billing",
    async () =>
      extendTrial(
        services().billing,
        await getPlatformContext(),
        uuid(form.get("tenantId")),
        {
          days: form.get("days"),
          reason: form.get("reason"),
        },
      ),
    "Trial extended.",
  );
}

export async function compAction(form: FormData) {
  return runAndReturn(
    "/billing",
    async () =>
      compSubscription(
        services().billing,
        await getPlatformContext(),
        uuid(form.get("tenantId")),
        {
          until: form.get("until"),
          reason: form.get("reason"),
        },
      ),
    "Free access given.",
  );
}

export async function createAnnouncementAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const raw = formDataToObject(form) as Record<string, unknown>;
    return createAnnouncement(services().db, await getPlatformContext(), {
      ...raw,
      startsAt: ist(raw.startsAt) ?? new Date().toISOString(),
      endsAt: ist(raw.endsAt) ?? "",
      planCodes: form.getAll("planCodes").map(String),
      statuses: form.getAll("statuses").map(String),
    });
  }, "Announcement published.");
}

export async function archiveAnnouncementAction(form: FormData) {
  return runAndReturn(
    "/announcements",
    async () =>
      archiveAnnouncement(
        services().db,
        await getPlatformContext(),
        uuid(form.get("id")),
      ),
    "Announcement taken down.",
  );
}

export async function retryJobAction(form: FormData) {
  return runAndReturn(
    "/system",
    async () =>
      retryFailedJob(
        services().db,
        services().redis,
        await getPlatformContext(),
        {
          queue: form.get("queue"),
          jobId: form.get("jobId"),
        },
      ),
    "Job queued again.",
  );
}

export async function retryOutboxAction(form: FormData) {
  return runAndReturn(
    "/system",
    async () =>
      retryOutboxRow(services().db, await getPlatformContext(), {
        id: form.get("id"),
      }),
    "Queued again.",
  );
}
