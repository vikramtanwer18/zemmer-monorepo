import {
  ActionForm,
  CheckboxField,
  FormField,
  SelectField,
  SubmitButton,
  type FormAction,
} from "@gym/ui";
import type { TemplateOptions } from "../template-form";

/** Trainer, room and capacity for one session (time changes: cancel and create a new one). */
export function EditSession({
  action,
  sessionId,
  options,
  values,
}: {
  action: FormAction;
  sessionId: string;
  options: TemplateOptions;
  values: { trainerId: string; roomId: string; capacity: number };
}) {
  return (
    <ActionForm action={action} className="flex flex-col gap-3">
      <input type="hidden" name="sessionId" value={sessionId} />
      <SelectField
        label="Trainer"
        name="trainerId"
        defaultValue={values.trainerId}
        placeholder="No trainer"
        options={options.trainers.map((t) => ({
          value: t.id,
          label: t.displayName,
        }))}
      />
      <SelectField
        label="Room"
        name="roomId"
        defaultValue={values.roomId}
        placeholder="No room"
        options={options.rooms.map((r) => ({ value: r.id, label: r.name }))}
      />
      <FormField
        label="Places"
        name="capacity"
        type="number"
        min={1}
        defaultValue={values.capacity}
      />
      <CheckboxField
        name="ignoreConflicts"
        label="Save even if the trainer or room is busy"
      />
      <div>
        <SubmitButton variant="outline">Save</SubmitButton>
      </div>
    </ActionForm>
  );
}
