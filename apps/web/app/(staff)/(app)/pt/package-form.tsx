import {
  ActionForm,
  FormField,
  SubmitButton,
  TextareaField,
  type FormAction,
} from "@gym/ui";

export function PackageForm({
  action,
  values = {},
  submitLabel,
}: {
  action: FormAction;
  values?: Partial<{
    id: string;
    name: string;
    description: string | null;
    sessionCount: number;
    validityDays: number;
    sessionMinutes: number;
    price: string;
    taxRateBps: number;
    sacCode: string;
  }>;
  submitLabel: string;
}) {
  return (
    <ActionForm action={action} className="flex max-w-2xl flex-col gap-4">
      {values.id && <input type="hidden" name="packageId" value={values.id} />}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField
          label="Name"
          name="name"
          required
          defaultValue={values.name}
        />
        <FormField
          label="Price (₹)"
          name="price"
          inputMode="decimal"
          required
          defaultValue={values.price}
          hint="As entered on invoices (with or without tax, per your billing settings)."
        />
        <FormField
          label="Sessions"
          name="sessionCount"
          type="number"
          min={1}
          required
          defaultValue={values.sessionCount ?? 10}
        />
        <FormField
          label="Valid for (days from activation)"
          name="validityDays"
          type="number"
          min={1}
          required
          defaultValue={values.validityDays ?? 60}
        />
        <FormField
          label="Session length (minutes)"
          name="sessionMinutes"
          type="number"
          min={15}
          defaultValue={values.sessionMinutes ?? 60}
        />
        <FormField
          label="GST rate (basis points)"
          name="taxRateBps"
          type="number"
          min={0}
          defaultValue={values.taxRateBps ?? 1800}
          hint="1800 = 18%"
        />
        <FormField
          label="SAC code"
          name="sacCode"
          defaultValue={values.sacCode ?? "999723"}
        />
      </div>
      <TextareaField
        label="Description"
        name="description"
        rows={2}
        defaultValue={values.description ?? ""}
      />
      <div>
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
