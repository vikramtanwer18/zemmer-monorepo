import { hasPermission } from "@gym/core/authz";
import { copilotUsage } from "@gym/core/copilot";
import { EmptyState, PageHeader } from "@gym/ui";
import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { CopilotChat } from "@/components/copilot-chat";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";

export const metadata: Metadata = { title: "Copilot" };

const SUGGESTIONS = [
  "Which memberships expire this week?",
  "Which leads require follow-up today?",
  "Summarize this week's business performance",
  "Why did revenue change this month?",
  "Which branches have declining attendance?",
  "Who has overdue dues?",
  "Which campaigns produced the most paid memberships?",
  "What payments require reconciliation?",
];

export default async function CopilotPage() {
  const { ctx } = await requireReady("/copilot");
  if (!hasPermission(ctx, "ai.use"))
    return (
      <>
        <PageHeader title="Copilot" />
        <NoAccess />
      </>
    );
  const { deps, ai } = services();
  const usage = await orUpgrade(copilotUsage(deps, ai, ctx));
  if (!usage) return <UpgradeNotice title="Copilot" feature="The AI Copilot" />;
  return (
    <>
      <PageHeader
        title="Copilot"
        description={`Ask about your gym in plain words. Answers use your reports' figures and list their sources.${usage.limit !== null ? ` ${usage.used} of ${usage.limit} questions used this month.` : ""}`}
      />
      {usage.available ? (
        <CopilotChat suggestions={SUGGESTIONS} fake={usage.fake} />
      ) : (
        <EmptyState
          icon={Sparkles}
          title="The Copilot isn't switched on yet"
          description="The platform team needs to connect an AI provider. Your reports work as usual."
        />
      )}
    </>
  );
}
