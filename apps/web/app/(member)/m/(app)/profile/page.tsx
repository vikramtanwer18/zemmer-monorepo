import { getMyProfile } from "@gym/core/members";
import {
  ActionForm,
  Card,
  CardTitle,
  CheckboxField,
  FormField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";
import {
  changePasswordAction,
  memberSignOutAction,
  setMarketingConsentAction,
  updateMyProfileAction,
} from "../../actions";

import { MemberSignOut } from "@/components/member-sign-out";

export const metadata: Metadata = { title: "Profile" };

export default async function MyProfilePage() {
  const { mctx, user } = await requireMember("/m/profile");
  const { profile, consents } = await getMyProfile(services().db, mctx);

  return (
    <>
      <h1 className="text-2xl font-semibold">Profile</h1>
      <Card>
        <CardTitle>
          {profile.firstName} {profile.lastName ?? ""}
        </CardTitle>
        <p className="text-sm text-muted">{user.email}</p>
        <p className="mt-1 text-xs text-muted">
          To change your name or email, ask the front desk.
        </p>
      </Card>

      <Card>
        <CardTitle>Contact details</CardTitle>
        <ActionForm
          action={updateMyProfileAction}
          className="mt-4 flex flex-col gap-4"
        >
          <FormField
            label="Mobile number"
            name="phone"
            type="tel"
            autoComplete="tel"
            defaultValue={profile.phone ?? ""}
            required
          />
          <FormField
            label="Emergency contact name"
            name="emergencyName"
            defaultValue={profile.emergencyName ?? ""}
          />
          <FormField
            label="Emergency contact number"
            name="emergencyPhone"
            type="tel"
            defaultValue={profile.emergencyPhone ?? ""}
          />
          <SubmitButton>Save</SubmitButton>
        </ActionForm>
      </Card>

      <Card>
        <CardTitle>Offers and news</CardTitle>
        <p className="mt-1 text-sm text-muted">
          Reminders about your membership and payments are always sent. These
          choices are only for offers.
        </p>
        <ActionForm
          action={setMarketingConsentAction}
          className="mt-4 flex flex-col gap-3"
        >
          {consents.marketingEmail && (
            <input type="hidden" name="marketingEmailWas" value="on" />
          )}
          {consents.marketingWhatsapp && (
            <input type="hidden" name="marketingWhatsappWas" value="on" />
          )}
          <CheckboxField
            name="marketingEmail"
            label="Email me offers"
            defaultChecked={consents.marketingEmail}
          />
          <CheckboxField
            name="marketingWhatsapp"
            label="WhatsApp me offers"
            defaultChecked={consents.marketingWhatsapp}
          />
          <SubmitButton variant="outline">Save choices</SubmitButton>
        </ActionForm>
      </Card>

      <Card>
        <CardTitle>Change password</CardTitle>
        <ActionForm
          action={changePasswordAction}
          className="mt-4 flex flex-col gap-4"
        >
          <FormField
            label="Current password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
          <FormField
            label="New password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters."
            required
          />
          <FormField
            label="Repeat new password"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
          />
          <SubmitButton variant="outline">Change password</SubmitButton>
        </ActionForm>
      </Card>

      <MemberSignOut action={memberSignOutAction} />
    </>
  );
}
