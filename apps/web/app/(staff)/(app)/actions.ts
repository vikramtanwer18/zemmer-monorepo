"use server";

import { selectBranch } from "@gym/auth/tenant";
import { AppError } from "@gym/core/errors";
import {
  confirmLogoUpload,
  deactivateOwnAccount,
  createBranch,
  createLogoUpload,
  inviteStaff,
  resendInvitation,
  revokeInvitation,
  setBranchArchived,
  setStaffActive,
  updateBillingSettings,
  updateBranch,
  updateOrgProfile,
  updateSecuritySettings,
  updateTaxSettings,
} from "@gym/core/tenancy";
import { markNotificationsRead } from "@gym/core/notifications";
import { formDataToObject } from "@gym/core/validation";
import type { FormActionResult } from "@gym/ui";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, runAction } from "@/lib/action";
import { services } from "@/lib/services";
import { getAuthContext, getSessionState } from "@/lib/session";

/** Confirm-dialog actions: run, then come back to `path` with a notice or an error. */
async function runAndReturn(
  path: string,
  fn: () => Promise<unknown>,
  notice: string,
): Promise<never> {
  const result = await runAction(fn);
  const params = new URLSearchParams(
    result.ok ? { notice } : { error: result.error.message.slice(0, 200) },
  );
  redirect(`${path}?${params}`);
}

const uuid = (value: FormDataEntryValue | null) => z.uuid().parse(value);

// --- header --------------------------------------------------------------------------

export async function selectBranchAction(form: FormData) {
  const state = await getSessionState();
  if (state.kind !== "ready") redirect("/");
  const raw = form.get("branchId");
  const branchId =
    raw && raw !== "all" ? (z.uuid().safeParse(raw).data ?? null) : null;
  await selectBranch(services().db, state, branchId);
  const back = form.get("back");
  redirect(
    typeof back === "string" && back.startsWith("/") && !back.startsWith("//")
      ? back
      : "/",
  );
}

// --- branches ------------------------------------------------------------------------

export async function createBranchAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  const result = await runAction(async () =>
    createBranch(
      services().deps,
      await getAuthContext(),
      formDataToObject(form),
    ),
  );
  if (!result.ok) return result;
  redirect(
    `/branches?notice=${encodeURIComponent(`Branch ${result.data.name} created.`)}`,
  );
}

export async function updateBranchAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const id = uuid(form.get("id"));
    await updateBranch(
      services().deps,
      await getAuthContext(),
      id,
      formDataToObject(form),
    );
  }, "Branch saved.");
}

export async function archiveBranchAction(form: FormData) {
  const id = String(form.get("id"));
  const archived = form.get("archived") === "true";
  return runAndReturn(
    `/branches/${id}`,
    async () =>
      setBranchArchived(
        services().deps,
        await getAuthContext(),
        uuid(id),
        archived,
      ),
    archived ? "Branch archived." : "Branch restored.",
  );
}

// --- staff ---------------------------------------------------------------------------

export async function inviteStaffAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(async () => {
    const branch = form.get("branchId");
    const roleKey = form.get("roleKey");
    if (!roleKey) {
      throw new AppError("VALIDATION_FAILED", "Choose a role.", {
        fields: { roleKey: ["Choose a role."] },
      });
    }
    const { deps, invitationMailer } = services();
    await inviteStaff(deps, invitationMailer, await getAuthContext(), {
      email: form.get("email"),
      roles: [
        {
          roleKey,
          branchId: branch && branch !== "all" ? branch : null,
        },
      ],
    });
  }, "Invitation sent.");
}

export async function resendInvitationAction(form: FormData) {
  return runAndReturn(
    "/staff",
    async () => {
      const { deps, invitationMailer } = services();
      await resendInvitation(
        deps,
        invitationMailer,
        await getAuthContext(),
        uuid(form.get("id")),
      );
    },
    "Invitation sent again.",
  );
}

export async function revokeInvitationAction(form: FormData) {
  return runAndReturn(
    "/staff",
    async () =>
      revokeInvitation(
        services().deps,
        await getAuthContext(),
        uuid(form.get("id")),
      ),
    "Invitation cancelled.",
  );
}

export async function setStaffActiveAction(form: FormData) {
  const active = form.get("active") === "true";
  return runAndReturn(
    "/staff",
    async () =>
      setStaffActive(
        services().deps,
        await getAuthContext(),
        uuid(form.get("membershipId")),
        active,
      ),
    active ? "Access restored." : "Access removed.",
  );
}

// --- settings ------------------------------------------------------------------------

export async function updateProfileAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      updateOrgProfile(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Organisation profile saved.",
  );
}

export async function updateTaxAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      updateTaxSettings(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Tax settings saved.",
  );
}

export async function updateSecurityAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      updateSecuritySettings(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Security settings saved.",
  );
}

/** Logo step 1: returns a presigned POST for the browser to upload directly to storage. */
export async function requestLogoUploadAction(input: {
  contentType: string;
  size: number;
}) {
  return runAction(async () =>
    createLogoUpload(
      services().deps,
      services().storage,
      await getAuthContext(),
      input,
    ),
  );
}

/** Logo step 2: verifies the upload and saves it. */
export async function confirmLogoUploadAction(key: string) {
  return runAction(async () =>
    confirmLogoUpload(
      services().deps,
      services().storage,
      await getAuthContext(),
      key,
    ),
  );
}

// --- account -------------------------------------------------------------------------

export async function revokeSessionAction(form: FormData) {
  return runAndReturn(
    "/account",
    async () => {
      const id = uuid(form.get("sessionId"));
      const { auth } = services();
      const h = new Headers(await headers());
      const sessions = await auth.api.listSessions({ headers: h });
      const target = sessions.find((s) => s.id === id);
      if (!target)
        throw new AppError("NOT_FOUND", "That session has already ended.");
      await auth.api.revokeSession({
        body: { token: target.token },
        headers: h,
      });
    },
    "Session signed out.",
  );
}

export async function revokeOtherSessionsAction() {
  return runAndReturn(
    "/account",
    async () => {
      await services().auth.api.revokeOtherSessions({
        headers: new Headers(await headers()),
      });
    },
    "Signed out of every other device.",
  );
}

export async function forgetTrustedDevicesAction() {
  return runAndReturn(
    "/account",
    async () => {
      const state = await getSessionState();
      if (state.kind !== "ready")
        throw new AppError("AUTH_REQUIRED", "Please sign in again.");
      await services().db.trustedDevice.deleteMany({
        where: { userId: state.user.id },
      });
    },
    "Trusted devices forgotten. You'll be asked for a code next time.",
  );
}

/**
 * Deactivates the signed-in user's own account everywhere. Refused while they are the only active
 * owner of a gym (that gym would be left without an owner).
 */
export async function deactivateAccountAction(form: FormData) {
  if (form.get("confirm") !== "DEACTIVATE") {
    redirect(
      `/account?error=${encodeURIComponent("Type DEACTIVATE to confirm.")}`,
    );
  }
  const result = await runAction(async () => {
    const state = await getSessionState();
    if (state.kind !== "ready")
      throw new AppError("AUTH_REQUIRED", "Please sign in again.");
    await deactivateOwnAccount(services().db, state.user.id, state.ctx.request);
  });
  if (!result.ok)
    redirect(`/account?error=${encodeURIComponent(result.error.message)}`);
  redirect("/sign-in?deactivated=1");
}

export async function updateBillingSettingsAction(
  _: FormActionResult | null,
  form: FormData,
): Promise<FormActionResult> {
  return formAction(
    async () =>
      updateBillingSettings(
        services().deps,
        await getAuthContext(),
        formDataToObject(form),
      ),
    "Billing settings saved.",
  );
}

export async function markAllReadAction() {
  const ctx = await getAuthContext();
  await markNotificationsRead(services().db, ctx.tenantId, ctx.userId, "all");
  redirect("/notifications");
}
