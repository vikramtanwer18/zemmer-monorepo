import { expireDueTrials } from "@gym/core/platform";
import type { JobContext } from "../context";

/** Moves TRIALING subscriptions past their end date to the configured status (platform setting). */
export async function expireTrials(
  ctx: JobContext<"platform", "platform.expire-trials">,
) {
  const expired = await expireDueTrials(ctx.platform());
  if (expired.length)
    ctx.log.info(
      { count: expired.length, tenantIds: expired },
      "trials expired",
    );
  return { expired: expired.length };
}
