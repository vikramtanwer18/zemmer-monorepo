"use server";

import {
  applyCredit,
  issueCreditNote,
  recordManualRefund,
  recordPayment,
  voidInvoice,
  voidPayment,
} from "@gym/core/billing";
import { reissuePass, revokePass } from "@gym/core/attendance";
import { AppError } from "@gym/core/errors";
import { enqueue } from "@gym/core/jobs";
import {
  addMemberNote,
  bulkUpdateMembers,
  confirmDocumentUpload,
  createDocumentUpload,
  createMember,
  decideJoinRequest,
  inviteMemberToApp,
  recordConsent,
  updateMember,
  confirmPhotoUpload,
  createPhotoUpload,
} from "@gym/core/members";
import {
  cancelMembership,
  extendMembership,
  freezeMembership,
  renewMembership,
  sellMembership,
  unfreezeMembership,
} from "@gym/core/memberships";
import { parseMajorToMinor } from "@gym/core/money";
import { assignTrainer, endTrainerAssignment } from "@gym/core/staff";
import { formDataToObject } from "@gym/core/validation";
import { withTenant } from "@gym/db";
import type { FormActionResult } from "@gym/ui";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { getRedis } from "@/lib/queue";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

const uuid = (v: FormDataEntryValue | null) => z.uuid().parse(v);

/** Rupees typed in a form → paise, or a field error. */
function rupees(
  form: FormData,
  name: string,
  label: string,
  required = true,
): number {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw && !required) return 0;
  const minor = parseMajorToMinor(raw);
  if (minor === null || (required && minor <= 0)) {
    throw new AppError("VALIDATION_FAILED", `Enter the ${label} in rupees.`, {
      fields: { [name]: [`Enter the ${label} in rupees, e.g. 1180.`] },
    });
  }
  return minor;
}

async function back(
  path: string,
  fn: () => Promise<unknown>,
  notice: string,
): Promise<never> {
  const result = await runAction(fn);
  const params = new URLSearchParams(
    result.ok ? { notice } : { error: result.error.message.slice(0, 200) },
  );
  redirect(`${path}${path.includes("?") ? "&" : "?"}${params}`);
}

// --- members -----------------------------------------------------------------------------

export async function createMemberAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () =>
    createMember(
      services().deps,
      await getAuthContext(),
      formDataToObject(form),
    ),
  );
  if (!result.ok) return result;
  redirect(
    `/members/${result.data.id}?notice=${encodeURIComponent(`Member ${result.data.memberCode} added.`)}`,
  );
}

export async function updateMemberAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const id = uuid(form.get("memberId"));
  const result = await runAction(async () =>
    updateMember(
      services().deps,
      await getAuthContext(),
      id,
      formDataToObject(form),
    ),
  );
  if (!result.ok) return result;
  redirect(`/members/${id}?notice=${encodeURIComponent("Member saved.")}`);
}

export async function bulkMembersAction(form: FormData) {
  const ids = form.getAll("memberIds").map(String);
  const action = String(form.get("action"));
  const back = String(form.get("back") ?? "/members");
  const safeBack = back.startsWith("/members") ? back : "/members";
  const result = await runAction(async () =>
    bulkUpdateMembers(services().deps, await getAuthContext(), {
      action,
      memberIds: ids,
      branchId: form.get("branchId") || undefined,
      tag: form.get("tag") || undefined,
    }),
  );
  const params = new URLSearchParams(
    result.ok
      ? { notice: `${result.data.changed} member(s) updated.` }
      : { error: result.error.message },
  );
  redirect(`${safeBack}${safeBack.includes("?") ? "&" : "?"}${params}`);
}

export async function addNoteAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    await addMemberNote(
      services().deps,
      await getAuthContext(),
      uuid(form.get("memberId")),
      formDataToObject(form),
    );
  }, "Note added.");
}

export async function consentAction(form: FormData) {
  const id = uuid(form.get("memberId"));
  return back(
    `/members/${id}?tab=consents`,
    async () =>
      recordConsent(
        services().deps,
        await getAuthContext(),
        id,
        formDataToObject(form),
      ),
    "Consent updated.",
  );
}

export async function inviteToAppAction(form: FormData) {
  const id = uuid(form.get("memberId"));
  return back(
    `/members/${id}`,
    async () => {
      const { deps, memberInviteMailer } = services();
      return inviteMemberToApp(
        deps,
        memberInviteMailer,
        await getAuthContext(),
        id,
      );
    },
    "App invite sent.",
  );
}

export async function joinDecisionAction(form: FormData) {
  const id = uuid(form.get("memberId"));
  const approve = form.get("approve") === "true";
  return back(
    `/members/${id}`,
    async () =>
      decideJoinRequest(services().deps, await getAuthContext(), id, approve),
    approve ? "Member approved." : "Request declined.",
  );
}

export async function requestDocumentUploadAction(
  memberId: string,
  input: { contentType: string; size: number; filename: string },
) {
  return runAction(async () => {
    const { deps, storage } = services();
    return createDocumentUpload(
      deps,
      storage,
      await getAuthContext(),
      memberId,
      input,
    );
  });
}

export async function confirmDocumentUploadAction(
  memberId: string,
  input: { key: string; title: string; filename: string },
) {
  return runAction(async () => {
    const { deps, storage } = services();
    await confirmDocumentUpload(
      deps,
      storage,
      await getAuthContext(),
      memberId,
      input,
    );
  });
}

// --- import / export ------------------------------------------------------------------------

export async function exportMembersAction(form: FormData) {
  return back(
    "/members/data",
    async () => {
      const ctx = await getAuthContext();
      if (!ctx.grants.some((g) => g.permissions.has("members.export")))
        throw new AppError("FORBIDDEN", "You can't export members.");
      const { db } = services();
      const job = await withTenant(db, ctx.tenantId, (tx) =>
        tx.dataJob.create({
          data: {
            tenantId: ctx.tenantId,
            kind: "MEMBER_EXPORT",
            createdById: ctx.userId,
            params: {
              status: String(form.get("status") || "ACTIVE"),
              ...(form.get("branchId")
                ? { branchId: String(form.get("branchId")) }
                : {}),
            },
          },
        }),
      );
      await enqueue(getRedis(), "data", "members.export", {
        tenantId: ctx.tenantId,
        actor: { type: "user", id: ctx.userId },
        idempotencyKey: `export-${job.id}`,
        data: { dataJobId: job.id },
      });
    },
    "Export started. It appears below when ready (usually a few seconds).",
  );
}

/** Upload is done by the browser to storage; this registers the file and queues the job. */
export async function startImportAction(input: {
  key: string;
  filename: string;
  size: number;
  dryRun: boolean;
}) {
  return runAction(async () => {
    const ctx = await getAuthContext();
    if (
      !ctx.grants.some(
        (g) => g.permissions.has("members.import") && g.branchId === null,
      )
    ) {
      throw new AppError("FORBIDDEN", "You can't import members.");
    }
    if (
      !new RegExp(`^tenants/${ctx.tenantId}/imports/[0-9a-f-]{36}\\.csv$`).test(
        input.key,
      )
    ) {
      throw new AppError(
        "FORBIDDEN",
        "That upload does not belong to this gym.",
      );
    }
    const { db, storage } = services();
    const head = await storage.head(input.key);
    if (!head || head.size > 5 * 1024 * 1024)
      throw new AppError(
        "VALIDATION_FAILED",
        "Upload a CSV file of at most 5 MB.",
      );
    const job = await withTenant(db, ctx.tenantId, async (tx) => {
      const file = await tx.fileRecord.create({
        data: {
          tenantId: ctx.tenantId,
          key: input.key,
          filename: input.filename.slice(0, 120),
          contentType: "text/csv",
          size: head.size,
          purpose: "IMPORT",
          scanStatus: "SKIPPED",
          uploadedByUserId: ctx.userId,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        },
      });
      return tx.dataJob.create({
        data: {
          tenantId: ctx.tenantId,
          kind: "MEMBER_IMPORT",
          dryRun: input.dryRun,
          inputFileId: file.id,
          createdById: ctx.userId,
        },
      });
    });
    await enqueue(getRedis(), "data", "members.import", {
      tenantId: ctx.tenantId,
      actor: { type: "user", id: ctx.userId },
      idempotencyKey: `import-${job.id}`,
      data: { dataJobId: job.id },
    });
    return { jobId: job.id };
  });
}

export async function requestImportUploadAction(input: { size: number }) {
  return runAction(async () => {
    const ctx = await getAuthContext();
    if (input.size > 5 * 1024 * 1024)
      throw new AppError(
        "VALIDATION_FAILED",
        "The file must be 5 MB or smaller.",
      );
    const key = `tenants/${ctx.tenantId}/imports/${crypto.randomUUID()}.csv`;
    const upload = await services().storage.createUpload({
      key,
      contentType: "text/csv",
      maxBytes: 5 * 1024 * 1024,
    });
    return { key, ...upload };
  });
}

/** Re-run a validated dry run for real. */
export async function runImportForRealAction(form: FormData) {
  const jobId = uuid(form.get("jobId"));
  return back(
    "/members/data",
    async () => {
      const ctx = await getAuthContext();
      const { db } = services();
      const dry = await withTenant(db, ctx.tenantId, (tx) =>
        tx.dataJob.findUnique({ where: { id: jobId } }),
      );
      if (!dry || !dry.dryRun || dry.status !== "SUCCEEDED" || !dry.inputFileId)
        throw new AppError("CONFLICT", "Run a successful check first.");
      const job = await withTenant(db, ctx.tenantId, (tx) =>
        tx.dataJob.create({
          data: {
            tenantId: ctx.tenantId,
            kind: "MEMBER_IMPORT",
            dryRun: false,
            inputFileId: dry.inputFileId,
            createdById: ctx.userId,
          },
        }),
      );
      await enqueue(getRedis(), "data", "members.import", {
        tenantId: ctx.tenantId,
        actor: { type: "user", id: ctx.userId },
        idempotencyKey: `import-${job.id}`,
        data: { dataJobId: job.id },
      });
    },
    "Import started.",
  );
}

// --- memberships -------------------------------------------------------------------------------

export async function sellMembershipAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const memberId = uuid(form.get("memberId"));
  const result = await runAction(async () => {
    const payNow = form.get("payNow") === "on";
    const payment = payNow
      ? {
          method: String(form.get("method")),
          amountMinor: rupees(form, "amount", "amount received"),
          reference: String(form.get("reference") ?? "") || undefined,
        }
      : undefined;
    return sellMembership(services().deps, await getAuthContext(), {
      memberId,
      planId: form.get("planId"),
      startDate: form.get("startDate") || undefined,
      couponCode: form.get("couponCode") || undefined,
      payment,
      leadId: form.get("leadId") || undefined,
    });
  });
  if (!result.ok) return result;
  redirect(
    `/members/${memberId}?tab=memberships&notice=${encodeURIComponent(`Sold. Invoice ${result.data.invoice.number} issued.`)}`,
  );
}

export async function renewAction(form: FormData) {
  const memberId = uuid(form.get("memberId"));
  return back(
    `/members/${memberId}?tab=memberships`,
    async () =>
      renewMembership(
        services().deps,
        await getAuthContext(),
        uuid(form.get("membershipId")),
        {},
      ),
    "Renewed. A new invoice was issued.",
  );
}

export async function extendAction(form: FormData) {
  const memberId = uuid(form.get("memberId"));
  return back(
    `/members/${memberId}?tab=memberships`,
    async () =>
      extendMembership(
        services().deps,
        await getAuthContext(),
        uuid(form.get("membershipId")),
        formDataToObject(form),
      ),
    "Membership extended.",
  );
}

export async function freezeAction(form: FormData) {
  const memberId = uuid(form.get("memberId"));
  return back(
    `/members/${memberId}?tab=memberships`,
    async () =>
      freezeMembership(
        services().deps,
        await getAuthContext(),
        uuid(form.get("membershipId")),
        formDataToObject(form),
      ),
    "Freeze booked.",
  );
}

export async function unfreezeAction(form: FormData) {
  const memberId = uuid(form.get("memberId"));
  return back(
    `/members/${memberId}?tab=memberships`,
    async () =>
      unfreezeMembership(
        services().deps,
        await getAuthContext(),
        uuid(form.get("membershipId")),
      ),
    "Freeze ended.",
  );
}

export async function cancelAction(form: FormData) {
  const memberId = uuid(form.get("memberId"));
  return back(
    `/members/${memberId}?tab=memberships`,
    async () =>
      cancelMembership(
        services().deps,
        await getAuthContext(),
        uuid(form.get("membershipId")),
        {
          reason: form.get("reason"),
          refundMinor: rupees(form, "refund", "refund", false),
          refundMethod: form.get("refundMethod") || undefined,
          refundReference: form.get("refundReference") || undefined,
        },
      ),
    "Membership cancelled.",
  );
}

// --- billing ------------------------------------------------------------------------------------

export async function recordPaymentAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const memberId = uuid(form.get("memberId"));
  const result = await runAction(async () => {
    const amountMinor = rupees(form, "amount", "amount received");
    const explicit = form.get("allocationMode") === "manual";
    const allocations = explicit
      ? [...form.entries()]
          .filter(([k]) => k.startsWith("alloc:"))
          .map(([k, v]) => ({
            invoiceId: k.slice(6),
            amountMinor: String(v).trim()
              ? (parseMajorToMinor(String(v)) ?? -1)
              : 0,
          }))
      : undefined;
    if (allocations?.some((a) => a.amountMinor < 0))
      throw new AppError(
        "VALIDATION_FAILED",
        "Allocation amounts must be in rupees.",
      );
    return recordPayment(services().deps, await getAuthContext(), {
      memberId,
      method: form.get("method"),
      amountMinor,
      receivedOn: form.get("receivedOn") || undefined,
      reference: form.get("reference") || undefined,
      notes: form.get("notes") || undefined,
      allocations,
    });
  });
  if (!result.ok) return result;
  const credit =
    result.data.creditMinor > 0
      ? ` ₹${(result.data.creditMinor / 100).toFixed(2)} added as credit.`
      : "";
  redirect(
    `/members/${memberId}?tab=billing&notice=${encodeURIComponent(`Payment recorded (receipt ${result.data.payment.receiptNumber}).${credit}`)}`,
  );
}

export async function voidPaymentAction(form: FormData) {
  const back_ = String(form.get("back") ?? "/payments");
  return back(
    back_.startsWith("/") ? back_ : "/payments",
    async () =>
      voidPayment(
        services().deps,
        await getAuthContext(),
        uuid(form.get("paymentId")),
        form.get("reason"),
      ),
    "Payment voided.",
  );
}

export async function voidInvoiceAction(form: FormData) {
  const id = uuid(form.get("invoiceId"));
  return back(
    `/invoices/${id}`,
    async () =>
      voidInvoice(
        services().deps,
        await getAuthContext(),
        id,
        form.get("reason"),
      ),
    "Invoice voided.",
  );
}

export async function creditNoteAction(form: FormData) {
  const id = uuid(form.get("invoiceId"));
  return back(
    `/invoices/${id}`,
    async () =>
      issueCreditNote(services().deps, await getAuthContext(), id, {
        amountMinor: rupees(form, "amount", "credit amount"),
        reason: form.get("reason"),
      }),
    "Credit note issued.",
  );
}

export async function applyCreditAction(form: FormData) {
  const memberId = uuid(form.get("memberId"));
  return back(
    `/members/${memberId}?tab=billing`,
    async () => applyCredit(services().deps, await getAuthContext(), memberId),
    "Credit applied.",
  );
}

export async function refundAction(form: FormData) {
  const memberId = uuid(form.get("memberId"));
  return back(
    `/members/${memberId}?tab=billing`,
    async () =>
      recordManualRefund(services().deps, await getAuthContext(), {
        memberId,
        amountMinor: rupees(form, "amount", "refund"),
        method: form.get("method"),
        reference: form.get("reference") || undefined,
        reason: form.get("reason"),
      }),
    "Refund recorded.",
  );
}

// --- M3: pass, photo, trainers ---------------------------------------------------------------

export async function reissuePassAction(form: FormData) {
  const memberId = z.uuid().parse(form.get("memberId"));
  const result = await runAction(async () =>
    reissuePass(services().deps, await getAuthContext(), memberId, {
      reason: form.get("reason"),
    }),
  );
  redirect(
    `/members/${memberId}?${new URLSearchParams({ tab: "attendance", ...(result.ok ? { notice: "New pass issued. The member's app picks it up next time it's online." } : { error: result.error.message }) })}`,
  );
}

export async function revokePassAction(form: FormData) {
  const memberId = z.uuid().parse(form.get("memberId"));
  const result = await runAction(async () =>
    revokePass(services().deps, await getAuthContext(), memberId, {
      reason: form.get("reason"),
    }),
  );
  redirect(
    `/members/${memberId}?${new URLSearchParams({ tab: "attendance", ...(result.ok ? { notice: "Pass cancelled. Scans of it are refused from now on." } : { error: result.error.message }) })}`,
  );
}

export async function requestPhotoUploadAction(
  memberId: string,
  input: { contentType: string; size: number },
) {
  return runAction(async () =>
    createPhotoUpload(
      services().deps,
      services().storage,
      await getAuthContext(),
      z.uuid().parse(memberId),
      input,
    ),
  );
}

export async function confirmPhotoUploadAction(memberId: string, key: string) {
  return runAction(async () =>
    confirmPhotoUpload(
      services().deps,
      services().storage,
      await getAuthContext(),
      z.uuid().parse(memberId),
      { key },
    ),
  );
}

export async function assignTrainerAction(form: FormData) {
  const memberId = z.uuid().parse(form.get("memberId"));
  const result = await runAction(async () =>
    assignTrainer(services().deps, await getAuthContext(), {
      memberId,
      trainerId: form.get("trainerId"),
      note: form.get("note") || undefined,
    }),
  );
  redirect(
    `/members/${memberId}?${new URLSearchParams({ tab: "training", ...(result.ok ? { notice: "Trainer assigned." } : { error: result.error.message }) })}`,
  );
}

export async function endAssignmentAction(form: FormData) {
  const memberId = z.uuid().parse(form.get("memberId"));
  const id = z.uuid().parse(form.get("assignmentId"));
  const result = await runAction(async () =>
    endTrainerAssignment(services().deps, await getAuthContext(), id, {
      reason: form.get("reason"),
    }),
  );
  redirect(
    `/members/${memberId}?${new URLSearchParams({ tab: "training", ...(result.ok ? { notice: "Trainer unassigned." } : { error: result.error.message }) })}`,
  );
}
