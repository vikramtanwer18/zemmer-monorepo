import { EmptyState } from "@gym/ui";
import { Lock } from "lucide-react";

/** Shown when the signed-in user lacks the permission for a page. */
export function NoAccess() {
  return (
    <EmptyState
      icon={Lock}
      title="You don't have access to this page"
      description="Ask your gym owner or administrator if you need it."
    />
  );
}
