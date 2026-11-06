import { Tabs } from "@gym/ui";

export function PaymentsTabs({ current }: { current: string }) {
  return (
    <Tabs
      label="Payments sections"
      current={current}
      items={[
        { href: "/payments", label: "Payments" },
        { href: "/payments/dues", label: "Dues" },
        { href: "/payments/links", label: "Payment links" },
        { href: "/payments/refunds", label: "Refunds" },
        { href: "/payments/reconciliation", label: "Reconciliation" },
      ]}
    />
  );
}
