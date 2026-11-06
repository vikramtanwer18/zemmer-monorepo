import { Tabs } from "@gym/ui";

const TABS = [
  { href: "/settings", label: "Organisation" },
  { href: "/settings/tax", label: "Tax" },
  { href: "/settings/billing", label: "Billing" },
  { href: "/settings/payments", label: "Online payments" },
  { href: "/settings/floor", label: "Check-in & classes" },
  { href: "/settings/crm", label: "Leads" },
  { href: "/settings/whatsapp", label: "WhatsApp" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/plan", label: "Plan & usage" },
];

export function SettingsTabs({ current }: { current: string }) {
  return <Tabs label="Settings sections" items={TABS} current={current} />;
}
