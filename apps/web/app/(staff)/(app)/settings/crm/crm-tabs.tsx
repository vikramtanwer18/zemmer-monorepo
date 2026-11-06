import { Tabs } from "@gym/ui";

export function CrmSettingsTabs({ current }: { current: string }) {
  return (
    <Tabs
      label="Lead settings"
      current={current}
      items={[
        { href: "/settings/crm", label: "Pipeline & rules" },
        { href: "/settings/crm/forms", label: "Capture forms" },
        { href: "/settings/crm/api", label: "Website API" },
      ]}
    />
  );
}
