import { GST_STATES } from "@gym/core/gst";
import { FormField, SelectField } from "@gym/ui";

const STATES = Object.entries(GST_STATES)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label));

export type MemberValues = {
  firstName?: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  emergencyName?: string | null;
  emergencyPhone?: string | null;
  homeBranchId?: string;
};

/** Fields shared by the add and edit member forms (inside an ActionForm). */
export function MemberFields({
  values = {},
  branches,
}: {
  values?: MemberValues;
  branches: { id: string; name: string }[];
}) {
  return (
    <>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold">Contact</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="First name"
            name="firstName"
            defaultValue={values.firstName}
            autoComplete="off"
            required
          />
          <FormField
            label="Last name"
            name="lastName"
            defaultValue={values.lastName ?? ""}
            autoComplete="off"
          />
          <FormField
            label="Mobile"
            name="phone"
            type="tel"
            defaultValue={values.phone ?? ""}
            hint="10-digit Indian mobile, or +country code."
          />
          <FormField
            label="Email"
            name="email"
            type="email"
            defaultValue={values.email ?? ""}
            hint="Needed for the member app and emailed receipts."
          />
        </div>
        <SelectField
          label="Home branch"
          name="homeBranchId"
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
          defaultValue={values.homeBranchId}
          required
        />
      </fieldset>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold">
          Personal (optional)
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Date of birth"
            name="dateOfBirth"
            type="date"
            defaultValue={values.dateOfBirth ?? ""}
          />
          <SelectField
            label="Gender"
            name="gender"
            placeholder="Not given"
            defaultValue={values.gender ?? ""}
            options={[
              { value: "FEMALE", label: "Female" },
              { value: "MALE", label: "Male" },
              { value: "OTHER", label: "Other" },
              { value: "UNDISCLOSED", label: "Prefer not to say" },
            ]}
          />
        </div>
        <FormField
          label="Address"
          name="addressLine1"
          defaultValue={values.addressLine1 ?? ""}
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
            placeholder="Not given"
            options={STATES}
            defaultValue={values.stateCode ?? ""}
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
            label="Emergency contact"
            name="emergencyName"
            defaultValue={values.emergencyName ?? ""}
          />
          <FormField
            label="Emergency phone"
            name="emergencyPhone"
            type="tel"
            defaultValue={values.emergencyPhone ?? ""}
          />
        </div>
      </fieldset>
    </>
  );
}
