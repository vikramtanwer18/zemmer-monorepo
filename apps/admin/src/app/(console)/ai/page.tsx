import { getAiProviderForAdmin } from "@gym/core/copilot";
import {
  ActionForm,
  Alert,
  CheckboxField,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import { saveAiProviderAction, testAiProviderAction } from "./actions";

export const metadata: Metadata = { title: "AI provider" };

export default async function AiProviderPage() {
  const { ctx } = await requireAdmin("/ai");
  const {
    provider: p,
    usage,
    usageSince,
  } = await getAiProviderForAdmin(services().deps, ctx);
  const canEdit = ctx.permissions.has("platform.settings.manage");
  return (
    <>
      <PageHeader
        title="AI provider"
        description="The OpenAI-compatible provider behind the gym Copilot. Change provider or model here without a deploy. The key is stored encrypted and never shown again."
      />
      {p?.lastTestedAt && (
        <Alert
          tone={
            p.lastTestOk ? (p.supportsTools ? "success" : "warning") : "danger"
          }
          title="Last connection test"
          className="mb-4 max-w-xl"
        >
          {p.lastTestMessage} (
          {p.lastTestedAt.toISOString().slice(0, 16).replace("T", " ")} UTC)
          {p.lastTestOk &&
            p.supportsTools === false &&
            " Gyms get the fallback mode: the server fetches the figures and the model only explains them."}
        </Alert>
      )}
      <ActionForm
        action={saveAiProviderAction}
        className="flex max-w-xl flex-col gap-4"
      >
        <fieldset disabled={!canEdit} className="flex flex-col gap-4">
          <FormField
            label="Provider name"
            name="label"
            defaultValue={p?.label ?? "OpenAI"}
            required
            hint="Shown to platform admins only."
          />
          <FormField
            label="API base URL"
            name="baseUrl"
            type="url"
            defaultValue={p?.baseUrl ?? "https://api.openai.com/v1"}
            required
            hint="Any Chat Completions-compatible endpoint. https only (http only for a model on this machine)."
          />
          <FormField
            label="Model id"
            name="model"
            defaultValue={p?.model ?? ""}
            placeholder="e.g. gpt-4.1-mini"
            required
          />
          <FormField
            label="API key"
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={
              p?.hasKey
                ? `Stored (${p.apiKeyHint}). Leave blank to keep it.`
                : "Paste the key"
            }
            hint={
              'Write "none" for a local server that needs no key. Changing the URL, model or key clears the last test.'
            }
          />
          <div className="grid grid-cols-2 gap-4">
            <FormField
              label="Timeout (ms)"
              name="timeoutMs"
              type="number"
              min={1000}
              max={120000}
              defaultValue={p?.timeoutMs ?? 30000}
              required
            />
            <FormField
              label="Max answer tokens"
              name="maxTokens"
              type="number"
              min={100}
              max={8000}
              defaultValue={p?.maxTokens ?? 800}
              required
            />
            <FormField
              label="Questions per gym per minute"
              name="tenantRatePerMinute"
              type="number"
              min={1}
              max={120}
              defaultValue={p?.tenantRatePerMinute ?? 6}
              required
              hint="And 10× that per day."
            />
            <FormField
              label="Keep request logs (days)"
              name="logRetentionDays"
              type="number"
              min={1}
              max={365}
              defaultValue={p?.logRetentionDays ?? 90}
              required
              hint="Logs hold tool names, timings and tokens only."
            />
          </div>
          <CheckboxField
            name="enabled"
            label="Copilot switched on for gyms whose plan includes it"
            hint="Needs a passing connection test with the saved settings."
            defaultChecked={p?.enabled ?? false}
          />
        </fieldset>
        {canEdit && (
          <div>
            <SubmitButton>Save provider</SubmitButton>
          </div>
        )}
      </ActionForm>
      {canEdit && p && (
        <ActionForm action={testAiProviderAction} className="mt-4 max-w-xl">
          <SubmitButton variant="outline">Test connection</SubmitButton>
        </ActionForm>
      )}

      <section className="mt-10" aria-labelledby="usage-h">
        <h2 id="usage-h" className="mb-3 text-base font-semibold">
          Usage since {usageSince.toISOString().slice(0, 10)}
        </h2>
        <DataTable
          columns={[
            { key: "tenant", header: "Gym", cell: (u) => u.tenant },
            {
              key: "requests",
              header: "Questions",
              cell: (u) => u.requests,
              className: "text-right tabular-nums",
            },
            {
              key: "fallbacks",
              header: "Fallback",
              cell: (u) => u.fallbacks,
              className: "text-right tabular-nums",
              hideOnMobile: true,
            },
            {
              key: "flagged",
              header: "Flagged numbers",
              cell: (u) => u.flagged,
              className: "text-right tabular-nums",
              hideOnMobile: true,
            },
            {
              key: "errors",
              header: "Errors",
              cell: (u) => u.errors,
              className: "text-right tabular-nums",
              hideOnMobile: true,
            },
            {
              key: "tokens",
              header: "Tokens (in / out)",
              cell: (u) =>
                `${u.promptTokens.toLocaleString("en-IN")} / ${u.completionTokens.toLocaleString("en-IN")}`,
              className: "text-right tabular-nums",
            },
          ]}
          rows={usage}
          rowKey={(u) => u.tenantId}
          empty={<EmptyState title="No Copilot questions this month" />}
        />
      </section>
    </>
  );
}
