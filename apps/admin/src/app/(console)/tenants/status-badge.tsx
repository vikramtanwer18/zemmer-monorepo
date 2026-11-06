import { Badge } from "@gym/ui";

const TONES = {
  ACTIVE: "success",
  PENDING_APPROVAL: "warning",
  SUSPENDED: "danger",
  CANCELLED: "neutral",
} as const;

export function StatusBadge({ status }: { status: keyof typeof TONES }) {
  return (
    <Badge tone={TONES[status]}>{status.replace("_", " ").toLowerCase()}</Badge>
  );
}
