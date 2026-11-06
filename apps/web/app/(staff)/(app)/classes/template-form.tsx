import {
  ActionForm,
  CheckboxField,
  FormField,
  SelectField,
  SubmitButton,
  TextareaField,
  type FormAction,
} from "@gym/ui";

export type TemplateOptions = {
  branches: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  trainers: { id: string; displayName: string }[];
  rooms: {
    id: string;
    name: string;
    branchId: string;
    branch: { name: string };
  }[];
  planCodes: { code: string; name: string }[];
};

export type TemplateValues = Partial<{
  id: string;
  branchId: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  trainerId: string | null;
  roomId: string | null;
  capacity: number;
  durationMinutes: number;
  startTime: string;
  byDays: number[];
  startDate: string;
  untilDate: string | null;
  occurrenceCount: number | null;
  eligiblePlanCodes: string[];
  bookingOpensHours: number;
  bookingClosesMinutes: number;
  cancelCutoffMinutes: number;
  waitlistEnabled: boolean;
  waitlistMax: number | null;
}>;

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function TemplateForm({
  action,
  options,
  values = {},
  submitLabel,
  oneOff = false,
}: {
  action: FormAction;
  options: TemplateOptions;
  values?: TemplateValues;
  submitLabel: string;
  /** One-off session form: a date instead of a recurrence. */
  oneOff?: boolean;
}) {
  const days = new Set(values.byDays ?? []);
  const codes = new Set(values.eligiblePlanCodes ?? []);
  return (
    <ActionForm action={action} className="flex max-w-3xl flex-col gap-6">
      {values.id && <input type="hidden" name="templateId" value={values.id} />}
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold">Class</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Name"
            name="name"
            required
            defaultValue={values.name}
          />
          <SelectField
            label="Branch"
            name="branchId"
            required
            defaultValue={values.branchId}
            disabled={!!values.id}
            options={options.branches.map((b) => ({
              value: b.id,
              label: b.name,
            }))}
          />
          {values.id && (
            <input type="hidden" name="branchId" value={values.branchId} />
          )}
          <SelectField
            label="Category"
            name="categoryId"
            defaultValue={values.categoryId ?? ""}
            placeholder="None"
            options={options.categories.map((c) => ({
              value: c.id,
              label: c.name,
            }))}
          />
          <SelectField
            label="Trainer"
            name="trainerId"
            defaultValue={values.trainerId ?? ""}
            placeholder="No trainer yet"
            options={options.trainers.map((t) => ({
              value: t.id,
              label: t.displayName,
            }))}
          />
          <SelectField
            label="Room"
            name="roomId"
            defaultValue={values.roomId ?? ""}
            placeholder="No room"
            options={options.rooms.map((r) => ({
              value: r.id,
              label: `${r.name} (${r.branch.name})`,
            }))}
          />
          <FormField
            label="Places"
            name="capacity"
            type="number"
            min={1}
            required
            defaultValue={values.capacity ?? 20}
          />
        </div>
        <TextareaField
          label="Description"
          name="description"
          rows={2}
          defaultValue={values.description ?? ""}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold">When</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {oneOff ? (
            <FormField label="Date" name="date" type="date" required />
          ) : (
            <FormField
              label="First date"
              name="startDate"
              type="date"
              required
              defaultValue={values.startDate}
            />
          )}
          <FormField
            label="Start time"
            name="startTime"
            type="time"
            required
            defaultValue={values.startTime ?? "06:30"}
          />
          <FormField
            label="Length (minutes)"
            name="durationMinutes"
            type="number"
            min={10}
            required
            defaultValue={values.durationMinutes ?? 60}
          />
        </div>
        {!oneOff && (
          <>
            <div
              role="group"
              aria-labelledby="days-label"
              className="flex flex-col gap-2"
            >
              <span id="days-label" className="text-sm font-medium">
                Repeats on
              </span>
              <div className="flex flex-wrap gap-3">
                {DAYS.map((label, i) => (
                  <label
                    key={label}
                    className="flex items-center gap-1.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      name="byDays"
                      value={i + 1}
                      defaultChecked={days.has(i + 1)}
                      className="size-4"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                label="Ends on (optional)"
                name="untilDate"
                type="date"
                defaultValue={values.untilDate ?? ""}
                hint="Leave both empty to repeat until you stop it."
              />
              <FormField
                label="Or after this many classes"
                name="occurrenceCount"
                type="number"
                min={1}
                defaultValue={values.occurrenceCount ?? ""}
              />
            </div>
          </>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold">Booking rules</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField
            label="Booking opens (hours before)"
            name="bookingOpensHours"
            type="number"
            min={1}
            defaultValue={values.bookingOpensHours ?? 168}
          />
          <FormField
            label="Booking closes (minutes before)"
            name="bookingClosesMinutes"
            type="number"
            min={0}
            defaultValue={values.bookingClosesMinutes ?? 0}
          />
          <FormField
            label="Free cancellation until (minutes before)"
            name="cancelCutoffMinutes"
            type="number"
            min={0}
            defaultValue={values.cancelCutoffMinutes ?? 120}
            hint="Later cancellations are 'late' and keep the class credit."
          />
        </div>
        <div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2">
          <CheckboxField
            name="waitlistEnabled"
            label="Waitlist when full (members move up automatically)"
            defaultChecked={values.waitlistEnabled ?? true}
          />
          {!oneOff && (
            <FormField
              label="Waitlist limit (optional)"
              name="waitlistMax"
              type="number"
              min={1}
              defaultValue={values.waitlistMax ?? ""}
            />
          )}
        </div>
        {options.planCodes.length > 0 && (
          <div
            role="group"
            aria-labelledby="plans-label"
            className="flex flex-col gap-2"
          >
            <span id="plans-label" className="text-sm font-medium">
              Only these plans may book (none ticked = any plan that includes
              classes)
            </span>
            <div className="flex flex-wrap gap-3">
              {options.planCodes.map((p) => (
                <label
                  key={p.code}
                  className="flex items-center gap-1.5 text-sm"
                >
                  <input
                    type="checkbox"
                    name="eligiblePlanCodes"
                    value={p.code}
                    defaultChecked={codes.has(p.code)}
                    className="size-4"
                  />
                  {p.name}
                </label>
              ))}
            </div>
          </div>
        )}
        {oneOff && (
          <CheckboxField
            name="ignoreConflicts"
            label="Save even if the trainer or room is busy then"
          />
        )}
      </fieldset>
      <div>
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
