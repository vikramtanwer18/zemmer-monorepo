import { listPlans } from "@gym/core/platform";
import {
  ActionForm,
  Alert,
  Badge,
  ConfirmDialog,
  FormField,
  PageHeader,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import {
  createPlanAction,
  newPlanVersionAction,
  setPlanStatusAction,
  updatePlanFeaturesAction,
} from "../actions";

export const metadata: Metadata = { title: "Plans & features" };

const STATUS_TONE = {
  DRAFT: "warning",
  ACTIVE: "success",
  RETIRED: "neutral",
} as const;

function show(value: unknown, type: string) {
  if (type === "QUOTA")
    return value === null ? "unlimited" : String(value ?? 0);
  if (type === "BOOLEAN") return value === true ? "true" : "false";
  return JSON.stringify(value ?? null);
}

export default async function PlansPage({ searchParams }: PageProps<"/plans">) {
  const { ctx } = await requireAdmin("/plans");
  const { plans, features } = await listPlans(services().deps, ctx);
  const canEdit = ctx.permissions.has("platform.plans.manage");
  const sp = await searchParams;

  return (
    <>
      <PageHeader
        title="Plans & features"
        description="Plans are versioned: to change a live plan, create a new version, edit the draft, then publish it. Existing subscribers stay on their version."
      />
      {typeof sp.notice === "string" && (
        <Alert tone="success" className="mb-4">
          {sp.notice}
        </Alert>
      )}
      {typeof sp.error === "string" && (
        <Alert tone="danger" className="mb-4">
          {sp.error}
        </Alert>
      )}

      <div className="flex flex-col gap-6">
        {plans.map((plan) => {
          const values = new Map(
            plan.features.map((f) => [f.featureKey, f.value]),
          );
          const draft = plan.status === "DRAFT";
          return (
            <section
              key={plan.id}
              aria-labelledby={`plan-${plan.id}`}
              className="rounded-lg border border-border bg-surface p-4"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2
                  id={`plan-${plan.id}`}
                  className="flex items-center gap-2 text-lg font-semibold"
                >
                  {plan.name}
                  <span className="text-sm font-normal text-muted">
                    {plan.code} v{plan.version}
                  </span>
                  <Badge tone={STATUS_TONE[plan.status]}>
                    {plan.status.toLowerCase()}
                  </Badge>
                  <span className="text-sm font-normal text-muted">
                    {plan.subscribers} subscriber(s)
                  </span>
                </h2>
                {canEdit && (
                  <div className="flex gap-2">
                    {plan.status !== "DRAFT" && (
                      <ConfirmDialog
                        trigger="New version"
                        title={`Create ${plan.code} v${plan.version + 1}?`}
                        description="Copies this plan's feature values into a new draft."
                        confirmLabel="Create draft"
                        confirmVariant="primary"
                        formAction={newPlanVersionAction}
                        fields={{ planId: plan.id }}
                      />
                    )}
                    {draft && (
                      <ConfirmDialog
                        trigger="Publish"
                        triggerVariant="primary"
                        title={`Publish ${plan.name} v${plan.version}?`}
                        description="It can then be given to tenants. Its values can no longer be edited."
                        confirmLabel="Publish"
                        confirmVariant="primary"
                        formAction={setPlanStatusAction}
                        fields={{ planId: plan.id, status: "ACTIVE" }}
                      />
                    )}
                    {plan.status === "ACTIVE" && (
                      <ConfirmDialog
                        trigger="Retire"
                        title={`Retire ${plan.name} v${plan.version}?`}
                        description="Current subscribers keep it; it can't be given to new tenants."
                        confirmLabel="Retire"
                        formAction={setPlanStatusAction}
                        fields={{ planId: plan.id, status: "RETIRED" }}
                      />
                    )}
                  </div>
                )}
              </div>
              <ActionForm action={updatePlanFeaturesAction}>
                <input type="hidden" name="planId" value={plan.id} />
                <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
                  {features.map((f) => {
                    const value = values.has(f.key)
                      ? values.get(f.key)
                      : f.defaultValue;
                    const id = `${plan.id}-${f.key}`;
                    return (
                      <div
                        key={f.key}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <label
                          htmlFor={id}
                          className="truncate"
                          title={f.description}
                        >
                          {f.key}
                        </label>
                        {draft && canEdit ? (
                          <input
                            id={id}
                            name={`f:${f.key}`}
                            defaultValue={show(value, f.type)}
                            className="h-8 w-28 rounded-md border border-border bg-surface px-2 text-sm"
                          />
                        ) : (
                          <output id={id} className="font-mono text-xs">
                            {show(value, f.type)}
                          </output>
                        )}
                      </div>
                    );
                  })}
                </div>
                {draft && canEdit && (
                  <div className="mt-4">
                    <SubmitButton variant="outline">
                      Save draft values
                    </SubmitButton>
                  </div>
                )}
              </ActionForm>
            </section>
          );
        })}
      </div>

      {canEdit && (
        <section aria-labelledby="new-plan" className="mt-8 max-w-xl">
          <h2 id="new-plan" className="mb-3 text-lg font-semibold">
            New plan
          </h2>
          <ActionForm
            action={createPlanAction}
            resetOnSuccess
            className="flex flex-col gap-3"
          >
            <FormField
              label="Code"
              name="code"
              hint="Lowercase, e.g. enterprise. Fixed once created."
              required
            />
            <FormField label="Name" name="name" required />
            <FormField label="Description" name="description" />
            <div>
              <SubmitButton variant="outline">Create draft plan</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
    </>
  );
}
