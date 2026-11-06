import { Badge } from "@gym/ui";

export function InvoiceBadge({ status }: { status: string }) {
  const tone =
    status === "PAID"
      ? "success"
      : status === "VOID"
        ? "neutral"
        : status.includes("REFUND")
          ? "info"
          : "warning";
  return <Badge tone={tone}>{status.replace("_", " ").toLowerCase()}</Badge>;
}
