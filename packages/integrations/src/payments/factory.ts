import {
  FakePaymentProvider,
  FakeSubscriptionProvider,
  redisFakeStore,
  type FakeStore,
} from "./fake";
import {
  RazorpayPaymentProvider,
  RazorpaySubscriptionProvider,
} from "./razorpay";
import type { PaymentProvider, SubscriptionProvider } from "./types";

type Account = {
  provider: "RAZORPAY" | "FAKE";
  keyId: string;
  keySecret: string;
};

type RedisLike = Parameters<typeof redisFakeStore>[0];

/**
 * Builds the provider for a connected account. The fake is refused unless explicitly enabled
 * (PAYMENTS_FAKE_ENABLED, never in production); its state lives in Redis so the web app, the
 * worker and tests share it.
 */
export function paymentProviderFactory(options: {
  fakeEnabled: boolean;
  redis?: RedisLike;
  store?: FakeStore;
  /** e.g. http://localhost:3000/dev/fake-pay */
  fakeCheckoutBase?: string;
}): (account: Account) => PaymentProvider {
  const store =
    options.store ??
    (options.redis ? redisFakeStore(options.redis) : undefined);
  return (account) => {
    if (account.provider === "RAZORPAY")
      return new RazorpayPaymentProvider(account.keyId, account.keySecret);
    if (!options.fakeEnabled || !store)
      throw new Error("The fake payment provider is not enabled here.");
    return new FakePaymentProvider(
      store,
      account.keyId,
      account.keySecret,
      options.fakeCheckoutBase,
    );
  };
}

export function subscriptionProviderFactory(options: {
  fakeEnabled: boolean;
  redis?: RedisLike;
  store?: FakeStore;
  /** e.g. http://localhost:3001/dev/fake-subscribe */
  fakeCheckoutBase?: string;
}): (account: Account) => SubscriptionProvider {
  const store =
    options.store ??
    (options.redis ? redisFakeStore(options.redis) : undefined);
  return (account) => {
    if (account.provider === "RAZORPAY")
      return new RazorpaySubscriptionProvider(account.keyId, account.keySecret);
    if (!options.fakeEnabled || !store)
      throw new Error("The fake payment provider is not enabled here.");
    return new FakeSubscriptionProvider(store, options.fakeCheckoutBase);
  };
}
