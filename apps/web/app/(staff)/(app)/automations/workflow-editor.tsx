import { EXIT_WHEN, STEP_LABELS, TRIGGER_LABELS } from "@gym/core/automation";
import {
  ActionForm,
  Card,
  CardTitle,
  FormField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import { saveWorkflowAction } from "./actions";

type Ref = { id: string; name: string };

const EXAMPLE = {
  trigger: { type: "membership.expiring", days: 7 },
  conditions: [],
  steps: [
    {
      type: "send_template",
      templateId: "<template id>",
      variables: { "1": { source: "first_name" } },
    },
    { type: "wait", hours: 48 },
    {
      type: "create_task",
      title: "Call {{first_name}} about renewing",
      dueInHours: 24,
      assignTo: "UNASSIGNED",
    },
  ],
  exitWhen: ["RENEWED"],
};

/**
 * Workflows are validated JSON (no code). The editor is a JSON box with everything it can refer
 * to listed beside it; saving always creates a new version and is validated on the server.
 */
export function WorkflowEditor({
  workflowId,
  name,
  definition,
  templates,
  stages,
  staff,
}: {
  workflowId: string | null;
  name: string;
  definition: unknown;
  templates: (Ref & { category: string; variables: string[] })[];
  stages: Ref[];
  staff: { userId: string; name: string }[];
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
      <ActionForm action={saveWorkflowAction} className="flex flex-col gap-3">
        {workflowId && (
          <input type="hidden" name="workflowId" value={workflowId} />
        )}
        <FormField label="Name" name="name" defaultValue={name} required />
        <TextareaField
          label="Definition (JSON)"
          name="definition"
          rows={22}
          className="font-mono text-xs"
          defaultValue={JSON.stringify(definition ?? EXAMPLE, null, 2)}
          hint="trigger · conditions · steps · exitWhen. Saving creates a new version; running ones keep theirs."
        />
        <div>
          <SubmitButton>Save new version</SubmitButton>
        </div>
      </ActionForm>
      <div className="flex flex-col gap-4 text-sm">
        <Card>
          <CardTitle>Triggers</CardTitle>
          <ul className="mt-2 flex flex-col gap-1">
            {Object.entries(TRIGGER_LABELS).map(([k, label]) => (
              <li key={k}>
                <code className="text-xs">{k}</code>{" "}
                <span className="text-muted">— {label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            “N days” triggers need <code>days</code>. retention.flagged may list{" "}
            <code>retentionKinds</code>.
          </p>
        </Card>
        <Card>
          <CardTitle>Steps</CardTitle>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {Object.entries(STEP_LABELS).map(([k, label]) => (
              <li key={k}>
                <code>{k}</code> <span className="text-muted">— {label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Conditions: <code>branch</code>, <code>plan</code>,{" "}
            <code>leadSource</code> (op <code>in</code>, list of ids),{" "}
            <code>amountMinor</code> (gte/lte paise), <code>segment</code>{" "}
            (audience id). Exit when: {EXIT_WHEN.join(", ")}. Variables:{" "}
            <code>{`{"1": {"source": "first_name"}}`}</code> or{" "}
            <code>{`{"text": "…"}`}</code>.
          </p>
        </Card>
        <Card>
          <CardTitle>Approved templates</CardTitle>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {templates.map((t) => (
              <li key={t.id}>
                <span className="font-medium">{t.name}</span> (
                {t.category.toLowerCase()},{" "}
                {t.variables.map((v) => `{{${v}}}`).join(" ") ||
                  "no placeholders"}
                )
                <br />
                <code className="select-all">{t.id}</code>
              </li>
            ))}
            {!templates.length && (
              <li className="text-muted">
                None yet: connect WhatsApp and sync templates.
              </li>
            )}
          </ul>
        </Card>
        <Card>
          <CardTitle>Lead stages and staff</CardTitle>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {stages.map((s) => (
              <li key={s.id}>
                {s.name}: <code className="select-all">{s.id}</code>
              </li>
            ))}
            {staff.map((s) => (
              <li key={s.userId}>
                {s.name}: <code className="select-all">{s.userId}</code>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
