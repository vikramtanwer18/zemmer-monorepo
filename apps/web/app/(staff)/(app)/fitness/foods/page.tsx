import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listFoodLibrary } from "@gym/core/nutrition";
import {
  ActionForm,
  Badge,
  Button,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { saveFoodAction } from "../actions";
import { FitnessTabs } from "../fitness-tabs";

export const metadata: Metadata = { title: "Foods" };

export default async function FoodsPage({
  searchParams,
}: PageProps<"/fitness/foods">) {
  const { ctx } = await requireReady("/fitness/foods");
  if (!hasPermission(ctx, "fitness.manage")) return <NoAccess />;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const rows = await orUpgrade(listFoodLibrary(services().deps, ctx, q));
  if (!rows)
    return <UpgradeNotice title="Foods" feature="Nutrition tracking" />;
  return (
    <>
      <PageHeader
        title="Fitness"
        description="Foods members pick from. Values per 100 g are typical estimates with their source; members can correct what they log."
      />
      <FitnessTabs current="/fitness/foods" nutrition />
      <Flash params={sp} />
      <form method="get" className="mb-3 flex max-w-md gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search foods"
          aria-label="Search foods"
          className="h-10 flex-1 rounded-md border border-border bg-surface px-3"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <DataTable
        caption="Foods"
        rows={rows}
        rowKey={(f) => f.id}
        empty={<EmptyState title="No foods match" />}
        columns={[
          {
            key: "name",
            header: "Food",
            cell: (f) => (
              <span>
                {f.name} {f.custom && <Badge>gym's own</Badge>}
              </span>
            ),
          },
          {
            key: "serving",
            header: "Serving",
            hideOnMobile: true,
            cell: (f) =>
              f.servingName ? `${f.servingName} (${f.servingGrams} g)` : "—",
          },
          { key: "kcal", header: "kcal/100 g", cell: (f) => f.kcal },
          {
            key: "macros",
            header: "P / C / F",
            cell: (f) => `${f.protein} / ${f.carbs} / ${f.fat}`,
          },
          {
            key: "source",
            header: "Source",
            hideOnMobile: true,
            cell: (f) => <span className="text-xs">{f.source}</span>,
          },
        ]}
      />
      {isTenantWritable(ctx) && (
        <section className="mt-8 max-w-2xl">
          <h2 className="mb-3 text-base font-semibold">Add a food</h2>
          <ActionForm
            action={saveFoodAction}
            resetOnSuccess
            className="grid gap-3 sm:grid-cols-4"
          >
            <div className="sm:col-span-2">
              <FormField label="Name" name="name" required />
            </div>
            <FormField
              label="Serving name"
              name="servingName"
              placeholder="1 katori"
            />
            <FormField
              label="Serving grams"
              name="servingGrams"
              inputMode="numeric"
            />
            <FormField
              label="kcal per 100 g"
              name="kcal"
              inputMode="decimal"
              required
            />
            <FormField
              label="Protein g"
              name="protein"
              inputMode="decimal"
              required
            />
            <FormField
              label="Carbs g"
              name="carbs"
              inputMode="decimal"
              required
            />
            <FormField label="Fat g" name="fat" inputMode="decimal" required />
            <div className="sm:col-span-4">
              <FormField
                label="Source of the numbers"
                name="source"
                required
                placeholder="Pack label / IFCT 2017 / own recipe estimate"
              />
            </div>
            <div>
              <SubmitButton>Add food</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
    </>
  );
}
