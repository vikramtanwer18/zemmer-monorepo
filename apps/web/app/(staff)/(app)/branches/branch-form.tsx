import { GST_STATES } from "@gym/core/gst";
import {
  ActionForm,
  FormField,
  SelectField,
  SubmitButton,
  type FormAction,
} from "@gym/ui";

const STATE_OPTIONS = Object.entries(GST_STATES)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label));

const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
];

export type BranchFormValues = {
  id?: string;
  name?: string;
  code?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  stateCode?: string;
  postalCode?: string | null;
  phone?: string | null;
  timezone?: string | null;
  gstin?: string | null;
};

export function BranchForm({
  action,
  values = {},
  submitLabel,
  disabled,
}: {
  action: FormAction;
  values?: BranchFormValues;
  submitLabel: string;
  disabled?: boolean;
}) {
  return (
    <ActionForm action={action} className="flex max-w-2xl flex-col gap-4">
      {values.id && <input type="hidden" name="id" value={values.id} />}
      <fieldset disabled={disabled} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Branch name"
            name="name"
            defaultValue={values.name}
            required
          />
          <FormField
            label="Code"
            name="code"
            defaultValue={values.code}
            hint="Short and unique, e.g. JPR-1. Used on invoices."
            required
          />
        </div>
        <FormField
          label="Address line 1"
          name="addressLine1"
          defaultValue={values.addressLine1 ?? ""}
        />
        <FormField
          label="Address line 2"
          name="addressLine2"
          defaultValue={values.addressLine2 ?? ""}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField
            label="City"
            name="city"
            defaultValue={values.city ?? ""}
          />
          <SelectField
            label="State"
            name="stateCode"
            options={STATE_OPTIONS}
            placeholder="Choose a state"
            defaultValue={values.stateCode}
            required
          />
          <FormField
            label="PIN code"
            name="postalCode"
            inputMode="numeric"
            defaultValue={values.postalCode ?? ""}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Phone"
            name="phone"
            type="tel"
            defaultValue={values.phone ?? ""}
          />
          <SelectField
            label="Timezone"
            name="timezone"
            options={TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
            placeholder="Same as the gym"
            defaultValue={values.timezone ?? ""}
          />
        </div>
        <FormField
          label="Branch GSTIN"
          name="gstin"
          defaultValue={values.gstin ?? ""}
          hint="Only if this branch is registered separately from the gym."
        />
      </fieldset>
      {!disabled && (
        <div>
          <SubmitButton>{submitLabel}</SubmitButton>
        </div>
      )}
    </ActionForm>
  );
}
