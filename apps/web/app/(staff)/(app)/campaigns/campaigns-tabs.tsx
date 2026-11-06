import { Tabs } from "@gym/ui";

export function CampaignsTabs({ current }: { current: string }) {
  return (
    <Tabs
      label="Campaign sections"
      current={current}
      items={[
        { href: "/campaigns", label: "Campaigns" },
        { href: "/campaigns/audiences", label: "Audiences" },
      ]}
    />
  );
}

export const SEND_STATUS = {
  NONE: { label: "Not set up", tone: "neutral" },
  DRAFT: { label: "Ready to launch", tone: "info" },
  SCHEDULED: { label: "Scheduled", tone: "warning" },
  SENDING: { label: "Sending", tone: "warning" },
  SENT: { label: "Sent", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "danger" },
} as const;
