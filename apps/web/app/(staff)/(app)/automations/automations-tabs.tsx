import { Tabs } from "@gym/ui";

export function AutomationsTabs({
  current,
  showWorkflows,
}: {
  current: string;
  showWorkflows: boolean;
}) {
  return (
    <Tabs
      label="Automation sections"
      current={current}
      items={[
        ...(showWorkflows
          ? [{ href: "/automations", label: "Workflows" }]
          : []),
        { href: "/automations/approvals", label: "Approvals" },
      ]}
    />
  );
}

export const EXEC_TONE = {
  RUNNING: "info",
  WAITING: "neutral",
  AWAITING_APPROVAL: "warning",
  COMPLETED: "success",
  EXITED: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
} as const;
