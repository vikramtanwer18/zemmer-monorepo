import { Tabs } from "@gym/ui";

export function LeadsTabs({ current }: { current: string }) {
  return (
    <Tabs
      label="Leads sections"
      current={current}
      items={[
        { href: "/leads", label: "List" },
        { href: "/leads/board", label: "Pipeline" },
        { href: "/leads/trials", label: "Trials" },
        { href: "/leads/campaigns", label: "Campaigns" },
        { href: "/leads/reports", label: "Reports" },
        { href: "/leads/import", label: "Import / export" },
      ]}
    />
  );
}

export const CATEGORY_TONE = {
  NEW: "info",
  CONTACTED: "neutral",
  TRIAL_SCHEDULED: "warning",
  TRIAL_ATTENDED: "warning",
  OFFER_SENT: "info",
  WON: "success",
  LOST: "danger",
} as const;
