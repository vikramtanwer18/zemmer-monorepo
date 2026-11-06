import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getRetentionRules } from "@gym/core/retention";
import { ActionForm, Card, PageHeader, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { saveRulesAction } from "../actions";

export const metadata: Metadata = { title: "Retention rules" };

export default async function RetentionRulesPage() {
  const { ctx } = await requireReady("/retention/rules");
  if (!hasPermission(ctx, "retention.view")) return <NoAccess />;
  const rules = await getRetentionRules(services().deps, ctx);
  const canEdit =
    isTenantWritable(ctx) && hasPermission(ctx, "settings.manage");
  return (
    <>
      <PageHeader
        title="Retention rules"
        description="When someone should be flagged. Worked out every night; a flag clears itself when the rule stops applying."
      />
      <ActionForm
        action={saveRulesAction}
        className="flex max-w-3xl flex-col gap-3"
      >
        <fieldset disabled={!canEdit} className="flex flex-col gap-3">
          {rules.map((r) => (
            <Card
              key={r.kind}
              className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex-1">
                <label className="flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    name={`${r.kind}.enabled`}
                    value="true"
                    defaultChecked={r.enabled}
                  />
                  {r.label}
                </label>
                <p className="text-xs text-muted">{r.help}</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="number"
                  name={`${r.kind}.threshold`}
                  min={r.min}
                  max={r.max}
                  defaultValue={r.threshold}
                  aria-label={`${r.label} threshold`}
                  className="h-10 w-24 rounded-md border border-border bg-surface px-3"
                />
                {r.unit}
              </label>
            </Card>
          ))}
          {canEdit && (
            <div>
              <SubmitButton>Save rules</SubmitButton>
            </div>
          )}
        </fieldset>
      </ActionForm>
    </>
  );
}
