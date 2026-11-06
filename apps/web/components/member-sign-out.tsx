"use client";

import { Button } from "@gym/ui";
import { wipeCard } from "@/lib/card-store";

/**
 * Member sign-out that also removes the offline card (pass secret) and the cached card page
 * from this device (D-09). The server action still signs out if the wipe fails.
 */
export function MemberSignOut({
  action,
  label = "Sign out",
}: {
  action: () => Promise<void>;
  label?: string;
}) {
  return (
    <form
      action={action}
      onSubmit={() => {
        void wipeCard();
        if ("caches" in window)
          void caches
            .keys()
            .then((keys) =>
              Promise.all(
                keys
                  .filter((k) => k.startsWith("gym-member-"))
                  .map((k) => caches.open(k).then((c) => c.delete("/m/card"))),
              ),
            )
            .catch(() => {});
      }}
    >
      <Button type="submit" variant="outline" className="w-full">
        {label}
      </Button>
    </form>
  );
}
