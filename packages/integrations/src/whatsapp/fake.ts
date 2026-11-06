import type { FakeStore } from "../payments/fake";
import {
  WhatsAppError,
  type PhoneNumberInfo,
  type ProviderTemplate,
  type SendResult,
  type TemplateSend,
  type WhatsAppClient,
  type WhatsAppCredentials,
} from "./types";

/**
 * Fake WhatsApp for tests, development and demos: no message ever leaves the machine. Sends are
 * recorded in the store; webhooks are built in Meta's shape (callers sign them with the app
 * secret and post them to our endpoint, exactly as Meta would).
 *
 * Tokens: anything not starting with "wrong-token" is accepted. `failNext()` makes the next sends fail with a
 * Meta error code (e.g. 130429 = rate limited, retryable; 131026 = undeliverable, permanent).
 */
export const FAKE_TEMPLATES: ProviderTemplate[] = [
  {
    id: "fake_tpl_renewal",
    name: "membership_renewal_reminder",
    language: "en",
    status: "APPROVED",
    category: "UTILITY",
    parameterFormat: "POSITIONAL",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, your {{2}} membership ends on {{3}}. Renew at the desk or in the app.",
      },
    ],
  },
  {
    id: "fake_tpl_payment",
    name: "payment_due_reminder",
    language: "en",
    status: "APPROVED",
    category: "UTILITY",
    parameterFormat: "POSITIONAL",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, {{2}} is due at {{3}}. Pay here: {{4}}",
      },
    ],
  },
  {
    id: "fake_tpl_class",
    name: "class_reminder",
    language: "en",
    status: "APPROVED",
    category: "UTILITY",
    parameterFormat: "POSITIONAL",
    components: [{ type: "BODY", text: "Hi {{1}}, reminder: {{2}} at {{3}}." }],
  },
  {
    id: "fake_tpl_trial",
    name: "trial_reminder",
    language: "en",
    status: "APPROVED",
    category: "UTILITY",
    parameterFormat: "POSITIONAL",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, your free trial at {{2}} is on {{3}}. See you!",
      },
    ],
  },
  {
    id: "fake_tpl_offer",
    name: "festive_offer",
    language: "en",
    status: "APPROVED",
    category: "MARKETING",
    parameterFormat: "NAMED",
    components: [
      {
        type: "BODY",
        text: "Hi {{first_name}}! {{gym}} has a festive offer for you. Reply STOP to opt out.",
      },
    ],
  },
  {
    id: "fake_tpl_winback",
    name: "we_miss_you",
    language: "en",
    status: "APPROVED",
    category: "MARKETING",
    parameterFormat: "POSITIONAL",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, we miss you at {{2}}! Come back this week. Reply STOP to opt out.",
      },
    ],
  },
  {
    id: "fake_tpl_pending",
    name: "new_batch_launch",
    language: "en",
    status: "PENDING",
    category: "MARKETING",
    parameterFormat: "POSITIONAL",
    components: [{ type: "BODY", text: "Hi {{1}}, a new batch starts soon." }],
  },
];

export type FakeSent = {
  id: string;
  phoneNumberId: string;
  to: string;
  kind: "TEMPLATE" | "TEXT";
  name?: string;
  language?: string;
  parameters?: string[] | Record<string, string>;
  body?: string;
  at: string;
};

export class FakeWhatsAppClient implements WhatsAppClient {
  readonly name = "FAKE" as const;
  constructor(private readonly store: FakeStore) {}

  private check(creds: WhatsAppCredentials) {
    if (creds.accessToken.startsWith("wrong-token"))
      throw new WhatsAppError("Invalid OAuth access token.", "190", false, 401);
  }

  async verify(creds: WhatsAppCredentials): Promise<PhoneNumberInfo> {
    this.check(creds);
    const digits = creds.phoneNumberId
      .replace(/\D/g, "")
      .slice(-10)
      .padStart(10, "9");
    return {
      displayPhone: `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`,
      verifiedName: "Test Gym",
      qualityRating: "GREEN",
      messagingLimit: "TIER_1K",
    };
  }

  async subscribeApp(creds: WhatsAppCredentials): Promise<void> {
    this.check(creds);
    await this.store.set(`wa:subscribed:${creds.wabaId}`, "1");
  }

  async listTemplates(creds: WhatsAppCredentials): Promise<ProviderTemplate[]> {
    this.check(creds);
    const custom = await this.store.get(`wa:templates:${creds.wabaId}`);
    return custom ? (JSON.parse(custom) as ProviderTemplate[]) : FAKE_TEMPLATES;
  }

  /** Test helper: replace this WABA's template list. */
  async setTemplates(wabaId: string, templates: ProviderTemplate[]) {
    await this.store.set(`wa:templates:${wabaId}`, JSON.stringify(templates));
  }

  /** Test helper: the next `times` sends from this number fail with this Meta error code. */
  async failNext(phoneNumberId: string, code: string, times = 1) {
    await this.store.set(
      `wa:fail:${phoneNumberId}`,
      JSON.stringify({ code, times }),
    );
  }

  private async maybeFail(phoneNumberId: string) {
    const raw = await this.store.get(`wa:fail:${phoneNumberId}`);
    if (!raw) return;
    const f = JSON.parse(raw) as { code: string; times: number };
    if (f.times <= 0) return;
    await this.store.set(
      `wa:fail:${phoneNumberId}`,
      JSON.stringify({ ...f, times: f.times - 1 }),
    );
    const retryable = ["130429", "131056", "131000"].includes(f.code);
    throw new WhatsAppError(
      retryable
        ? "(#130429) Rate limit hit"
        : "(#131026) Message undeliverable",
      f.code,
      retryable,
      retryable ? 429 : 400,
    );
  }

  private async record(
    entry: Omit<FakeSent, "id" | "at">,
  ): Promise<SendResult> {
    await this.maybeFail(entry.phoneNumberId);
    const n = await this.store.incr(`wa:seq:${entry.phoneNumberId}`);
    const id = `wamid.FAKE${entry.phoneNumberId.slice(-4)}${String(n).padStart(8, "0")}`;
    await this.store.set(
      `wa:sent:${entry.phoneNumberId}:${n}`,
      JSON.stringify({ ...entry, id, at: new Date().toISOString() }),
    );
    return { messageId: id };
  }

  async sendTemplate(
    creds: WhatsAppCredentials,
    m: TemplateSend,
  ): Promise<SendResult> {
    this.check(creds);
    return this.record({
      phoneNumberId: creds.phoneNumberId,
      to: m.to,
      kind: "TEMPLATE",
      name: m.name,
      language: m.language,
      parameters: m.parameters,
    });
  }

  async sendText(
    creds: WhatsAppCredentials,
    m: { to: string; body: string },
  ): Promise<SendResult> {
    this.check(creds);
    return this.record({
      phoneNumberId: creds.phoneNumberId,
      to: m.to,
      kind: "TEXT",
      body: m.body,
    });
  }

  /** Everything "sent" from this number, oldest first. */
  async sent(phoneNumberId: string): Promise<FakeSent[]> {
    const count = Number(
      (await this.store.get(`wa:seq:${phoneNumberId}`)) ?? 0,
    );
    const out: FakeSent[] = [];
    for (let i = 1; i <= count; i++) {
      const raw = await this.store.get(`wa:sent:${phoneNumberId}:${i}`);
      if (raw) out.push(JSON.parse(raw) as FakeSent);
    }
    return out;
  }
}

/** Meta-shaped webhook bodies (sign with signMetaWebhook before posting). */
export const fakeWebhooks = {
  status(input: {
    wabaId: string;
    phoneNumberId: string;
    messageId: string;
    status: "sent" | "delivered" | "read" | "failed";
    to?: string;
    errorCode?: string;
  }) {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: input.wabaId,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "919999999999",
                  phone_number_id: input.phoneNumberId,
                },
                statuses: [
                  {
                    id: input.messageId,
                    status: input.status,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    recipient_id: input.to ?? "919800000000",
                    pricing: {
                      billable: true,
                      pricing_model: "PMP",
                      category: "utility",
                    },
                    ...(input.status === "failed"
                      ? {
                          errors: [
                            {
                              code: Number(input.errorCode ?? 131026),
                              title: "Message undeliverable",
                            },
                          ],
                        }
                      : {}),
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  },
  inbound(input: {
    wabaId: string;
    phoneNumberId: string;
    from: string;
    text: string;
    name?: string;
    messageId?: string;
  }) {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: input.wabaId,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "919999999999",
                  phone_number_id: input.phoneNumberId,
                },
                contacts: [
                  {
                    profile: { name: input.name ?? "Customer" },
                    wa_id: input.from,
                  },
                ],
                messages: [
                  {
                    from: input.from,
                    id:
                      input.messageId ??
                      `wamid.IN${Date.now()}${Math.floor(Math.random() * 1e6)}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: input.text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  },
};
