import {
  INTERNAL_PATHS,
  internalCheckoutSchema,
  startCheckout,
} from "@gym/core/saas-billing";
import { internalRoute } from "@/lib/internal";
import { services } from "@/lib/services";

export const POST = internalRoute(
  INTERNAL_PATHS.checkout,
  internalCheckoutSchema,
  (input) =>
    startCheckout(services().billing, {
      tenantId: input.tenantId,
      priceId: input.priceId,
      requestedByUserId: input.userId,
    }),
);
