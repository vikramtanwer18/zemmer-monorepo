import { suggestVariableMap, VARIABLE_SOURCES } from "@gym/core/messaging";
import { Button } from "@gym/ui";
import { sendTemplateAction } from "@/app/(staff)/(app)/inbox/actions";

type Template = {
  id: string;
  name: string;
  category: string;
  variables: string[];
  bodyText: string | null;
};

/**
 * Pick an approved template (GET, so it works without JavaScript), then map each placeholder to
 * a member/lead field and send. Consent, opt-outs and the daily cap are checked at send time.
 */
export function TemplateSender({
  templates,
  chosenId,
  back,
  subject,
  flagId,
  extraParams = {},
}: {
  templates: Template[];
  chosenId: string | null;
  back: string;
  subject: { memberId?: string; leadId?: string; phone?: string };
  flagId?: string;
  /** Kept on the GET form (e.g. which row the picker is open on). */
  extraParams?: Record<string, string>;
}) {
  const chosen = chosenId
    ? templates.find((t) => t.id === chosenId)
    : undefined;
  const suggested = chosen ? suggestVariableMap(chosen.variables) : {};
  if (!templates.length)
    return (
      <p className="text-sm text-muted">
        No approved templates yet. Create them in WhatsApp Manager and sync.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <form method="get" className="flex flex-wrap items-center gap-2">
        {Object.entries(extraParams).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <select
          name="template"
          aria-label="Template"
          defaultValue={chosen?.id ?? ""}
          className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
        >
          <option value="">Choose a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.category.toLowerCase()})
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline" size="sm">
          Next
        </Button>
      </form>
      {chosen && (
        <form action={sendTemplateAction} className="flex flex-col gap-2">
          <input type="hidden" name="templateId" value={chosen.id} />
          <input type="hidden" name="back" value={back} />
          {flagId && <input type="hidden" name="flagId" value={flagId} />}
          {subject.memberId && (
            <input type="hidden" name="memberId" value={subject.memberId} />
          )}
          {subject.leadId && (
            <input type="hidden" name="leadId" value={subject.leadId} />
          )}
          {subject.phone && (
            <input type="hidden" name="phone" value={subject.phone} />
          )}
          <p className="text-xs text-muted">{chosen.bodyText}</p>
          {chosen.variables.map((v) => {
            const s = suggested[v];
            return (
              <label key={v} className="flex items-center gap-2 text-sm">
                <code className="w-24 text-xs">{`{{${v}}}`}</code>
                <select
                  name={`var_${v}`}
                  required
                  defaultValue={s && "source" in s ? s.source : "first_name"}
                  className="h-9 flex-1 rounded-md border border-border bg-surface px-2"
                >
                  {Object.entries(VARIABLE_SOURCES).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          {chosen.category === "MARKETING" && (
            <p className="text-xs text-muted">
              Promotional: goes only with their recorded WhatsApp marketing
              consent.
            </p>
          )}
          <div>
            <Button type="submit" size="sm">
              Send template
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
