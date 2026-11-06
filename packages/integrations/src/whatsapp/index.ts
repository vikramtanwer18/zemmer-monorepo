export * from "./types";
export {
  classifyMetaError,
  exchangeEmbeddedSignupCode,
  GRAPH_VERSION,
  MetaWhatsAppClient,
  parseMetaWebhook,
  placeholders,
  signMetaWebhook,
  templateBody,
  verifyMetaSignature,
} from "./meta";
export * from "./fake";

import {
  memoryFakeStore,
  redisFakeStore,
  type FakeStore,
} from "../payments/fake";
import { FakeWhatsAppClient } from "./fake";
import { MetaWhatsAppClient } from "./meta";
import type { WhatsAppClient } from "./types";

/** Picks the client per account: the fake only when enabled (refused in production by env checks). */
export function whatsappClientFactory(options: {
  fakeEnabled: boolean;
  redis?: Parameters<typeof redisFakeStore>[0];
  store?: FakeStore;
  fetchImpl?: typeof fetch;
}) {
  const meta = new MetaWhatsAppClient(options.fetchImpl);
  const fake = options.fakeEnabled
    ? new FakeWhatsAppClient(
        options.store ??
          (options.redis ? redisFakeStore(options.redis) : memoryFakeStore()),
      )
    : null;
  return (method: "MANUAL" | "EMBEDDED_SIGNUP" | "FAKE"): WhatsAppClient => {
    if (method === "FAKE") {
      if (!fake)
        throw new Error("The test WhatsApp provider is not enabled here.");
      return fake;
    }
    return meta;
  };
}
export type WhatsAppClientFactory = ReturnType<typeof whatsappClientFactory>;
