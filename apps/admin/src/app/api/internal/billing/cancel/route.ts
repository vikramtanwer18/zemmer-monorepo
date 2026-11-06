import {
  cancelAtPeriodEnd,
  INTERNAL_PATHS,
  internalCancelSchema,
} from "@gym/core/saas-billing";
import { internalRoute } from "@/lib/internal";
import { services } from "@/lib/services";

export const POST = internalRoute(
  INTERNAL_PATHS.cancel,
  internalCancelSchema,
  async (input) => {
    await cancelAtPeriodEnd(services().billing, {
      tenantId: input.tenantId,
      requestedByUserId: input.userId,
    });
    return { ok: true as const };
  },
);
