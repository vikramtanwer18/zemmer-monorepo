import { isAppError } from "@gym/core/errors";
import { EmptyState, LinkButton, PageHeader } from "@gym/ui";

/** Runs a page's first read; null when the gym's plan doesn't include the feature (402). */
export async function orUpgrade<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (isAppError(err) && err.code === "ENTITLEMENT_REQUIRED") return null;
    throw err;
  }
}

export function UpgradeNotice({
  title,
  feature,
}: {
  title: string;
  feature: string;
}) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        title={`${feature} isn't on your plan`}
        description="Upgrade your plan to use it. Your other data isn't affected."
        action={<LinkButton href="/settings/plan">See plans</LinkButton>}
      />
    </>
  );
}
