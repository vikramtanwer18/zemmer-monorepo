import {
  ActionForm,
  CheckboxField,
  FormField,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import { saveFormAction } from "../actions";

export type FormValues = {
  id?: string;
  name?: string;
  branchId?: string;
  title?: string;
  intro?: string | null;
  fields?: string[];
  consentText?: string;
  marketingText?: string | null;
  thankYou?: string;
  sourceId?: string | null;
  campaignId?: string | null;
  embedOrigins?: string[];
};

const OPTIONAL = [
  { value: "email", label: "Email" },
  { value: "interest", label: "What they're interested in" },
  { value: "preferredTime", label: "Preferred time" },
  { value: "message", label: "Message" },
];

export function FormEditor({
  values,
  branches,
  sources,
  campaigns,
}: {
  values: FormValues;
  branches: { id: string; name: string }[];
  sources: { id: string; name: string }[];
  campaigns: { id: string; name: string }[];
}) {
  return (
    <ActionForm
      action={saveFormAction}
      className="flex max-w-2xl flex-col gap-4"
    >
      {values.id && <input type="hidden" name="formId" value={values.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Name (for staff)"
          name="name"
          required
          defaultValue={values.name ?? "Website enquiry"}
        />
        <SelectField
          label="Leads go to branch"
          name="branchId"
          defaultValue={values.branchId ?? branches[0]?.id}
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
        />
        <FormField
          label="Heading"
          name="title"
          required
          defaultValue={values.title ?? "Book your free trial"}
        />
        <SelectField
          label="Source"
          name="sourceId"
          defaultValue={values.sourceId ?? ""}
          placeholder="From the link's utm_source, else Website"
          options={sources.map((s) => ({ value: s.id, label: s.name }))}
        />
        <SelectField
          label="Campaign"
          name="campaignId"
          defaultValue={values.campaignId ?? ""}
          placeholder="From the link's utm_campaign"
          options={campaigns.map((c) => ({ value: c.id, label: c.name }))}
        />
      </div>
      <TextareaField
        label="Intro (optional)"
        name="intro"
        rows={2}
        defaultValue={values.intro ?? ""}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">
          Fields (first name and mobile are always asked)
        </legend>
        {OPTIONAL.map((f) => (
          <CheckboxField
            key={f.value}
            name="fields"
            value={f.value}
            label={f.label}
            defaultChecked={(values.fields ?? ["email", "interest"]).includes(
              f.value,
            )}
          />
        ))}
      </fieldset>
      <TextareaField
        label="Consent checkbox text (required to submit)"
        name="consentText"
        rows={2}
        required
        defaultValue={
          values.consentText ??
          "I agree that {gym} may contact me by phone, WhatsApp or email about my enquiry and membership."
        }
        hint="{gym} becomes your gym's name. This exact text is saved with each lead."
      />
      <FormField
        label="Offers checkbox (optional)"
        name="marketingText"
        defaultValue={
          values.marketingText ?? "Send me offers and news (optional)"
        }
        hint="Leave empty to not ask. Needed before any promotional message."
      />
      <FormField
        label="Thank-you message"
        name="thankYou"
        required
        defaultValue={
          values.thankYou ?? "Thanks! We'll call you within the hour."
        }
      />
      <FormField
        label="Websites allowed to embed it (optional)"
        name="embedOrigins"
        defaultValue={(values.embedOrigins ?? []).join(" ")}
        placeholder="https://www.mygym.in"
        hint="Space-separated. Only these sites can show the form inside their pages."
      />
      <div>
        <SubmitButton>{values.id ? "Save form" : "Create form"}</SubmitButton>
      </div>
    </ActionForm>
  );
}
