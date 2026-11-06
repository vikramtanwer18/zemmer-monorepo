import { minorToMajorString } from "@gym/core/money";
import {
  ActionForm,
  CheckboxField,
  FormField,
  SelectField,
  SubmitButton,
  TextareaField,
  type FormAction,
} from "@gym/ui";

export type PlanValues = {
  id?: string;
  name?: string;
  description?: string | null;
  priceMinor?: bigint;
  joiningFeeMinor?: bigint;
  durationUnit?: string;
  durationCount?: number;
  taxRateBps?: number;
  sacCode?: string;
  isTrial?: boolean;
  accessScope?: string;
  branchIds?: string[];
  freezeMaxDays?: number;
  freezeMaxTimes?: number;
  freezeFeeMinor?: bigint;
  graceDays?: number;
  allowAddOn?: boolean;
  refundRule?: string;
  cancellationPolicy?: string | null;
  entitlements?: unknown;
};

const money = (v: bigint | undefined) =>
  v === undefined || v === 0n ? "" : minorToMajorString(Number(v));
const count = (v: unknown) =>
  v === null ? "unlimited" : typeof v === "number" && v > 0 ? String(v) : "";

export function PlanForm({
  action,
  values = {},
  branches,
  submitLabel,
  sold = 0,
}: {
  action: FormAction;
  values?: PlanValues;
  branches: { id: string; name: string }[];
  submitLabel: string;
  sold?: number;
}) {
  const ent = (values.entitlements ?? {}) as {
    classCredits?: number | null;
    ptSessions?: number | null;
  };
  return (
    <ActionForm action={action} className="flex max-w-3xl flex-col gap-6">
      {values.id && <input type="hidden" name="planId" value={values.id} />}
      {sold > 0 && (
        <p className="rounded-md bg-info-soft px-4 py-3 text-sm">
          {sold} membership(s) were sold on this plan. Saving creates a new
          version; those members keep their current terms.
        </p>
      )}
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold">Plan</legend>
        <FormField
          label="Name"
          name="name"
          defaultValue={values.name}
          required
        />
        <TextareaField
          label="Description"
          name="description"
          defaultValue={values.description ?? ""}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField
            label="Price (₹)"
            name="price"
            inputMode="decimal"
            defaultValue={money(values.priceMinor)}
            hint="As configured in tax settings (incl. or excl. GST)."
            required
          />
          <FormField
            label="Joining fee (₹)"
            name="joiningFee"
            inputMode="decimal"
            defaultValue={money(values.joiningFeeMinor)}
            hint="First membership only."
          />
          <CheckboxField
            name="isTrial"
            label="Trial plan"
            defaultChecked={values.isTrial}
          />
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <FormField
            label="Duration"
            name="durationCount"
            type="number"
            min={1}
            defaultValue={values.durationCount ?? 1}
            required
          />
          <SelectField
            label="Unit"
            name="durationUnit"
            defaultValue={values.durationUnit ?? "MONTH"}
            options={[
              { value: "DAY", label: "Days" },
              { value: "MONTH", label: "Months" },
              { value: "YEAR", label: "Years" },
            ]}
          />
          <SelectField
            label="GST rate"
            name="taxRateBps"
            defaultValue={String(values.taxRateBps ?? 1800)}
            options={[0, 500, 1200, 1800, 2800].map((v) => ({
              value: String(v),
              label: `${v / 100}%`,
            }))}
          />
          <FormField
            label="SAC code"
            name="sacCode"
            defaultValue={values.sacCode ?? "999723"}
            hint="Confirm with your CA."
            required
          />
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold">Access</legend>
        <SelectField
          label="Gives access to"
          name="accessScope"
          defaultValue={values.accessScope ?? "HOME_BRANCH"}
          options={[
            { value: "HOME_BRANCH", label: "The member's home branch" },
            { value: "ALL_BRANCHES", label: "Every branch" },
            { value: "LISTED_BRANCHES", label: "The branches ticked below" },
          ]}
        />
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">
            Sold at (none ticked = every branch)
          </p>
          {branches.map((b) => (
            <label key={b.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="branchIds"
                value={b.id}
                defaultChecked={values.branchIds?.includes(b.id)}
                className="size-4 accent-primary"
              />
              {b.name}
            </label>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField
            label="Grace days after expiry"
            name="graceDays"
            type="number"
            min={0}
            defaultValue={values.graceDays ?? 0}
          />
          <FormField
            label="Class credits"
            name="classCredits"
            defaultValue={count(ent.classCredits)}
            hint="Classes each membership can book: a number, 'unlimited', or empty for none."
          />
          <FormField
            label="PT sessions"
            name="ptSessions"
            defaultValue={count(ent.ptSessions)}
            hint="Number, 'unlimited' or empty."
          />
        </div>
        <CheckboxField
          name="allowAddOn"
          label="Add-on plan (can overlap another membership)"
          defaultChecked={values.allowAddOn}
        />
      </fieldset>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold">
          Freezing and cancellation
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField
            label="Freezes allowed"
            name="freezeMaxTimes"
            type="number"
            min={0}
            defaultValue={values.freezeMaxTimes ?? 0}
          />
          <FormField
            label="Freeze days in total"
            name="freezeMaxDays"
            type="number"
            min={0}
            defaultValue={values.freezeMaxDays ?? 0}
          />
          <FormField
            label="Freeze fee (₹)"
            name="freezeFee"
            inputMode="decimal"
            defaultValue={money(values.freezeFeeMinor)}
          />
        </div>
        <SelectField
          label="Refund on cancellation"
          name="refundRule"
          defaultValue={values.refundRule ?? "NONE"}
          options={[
            { value: "NONE", label: "No refunds" },
            {
              value: "FULL_BEFORE_START",
              label: "Full refund before it starts",
            },
            { value: "PRORATA", label: "Pro rata for unused days" },
          ]}
        />
        <TextareaField
          label="Cancellation policy (shown to staff and on the plan)"
          name="cancellationPolicy"
          defaultValue={values.cancellationPolicy ?? ""}
        />
      </fieldset>
      <div>
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
