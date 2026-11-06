/**
 * WhatsApp Cloud API behind one interface (D-12): the Meta implementation for real gyms, and a
 * fake (tests, development, demos) that records sends and emits Meta-shaped webhooks.
 */

export type WhatsAppCredentials = {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
};

export type PhoneNumberInfo = {
  displayPhone: string | null;
  verifiedName: string | null;
  /** GREEN, YELLOW, RED, UNKNOWN */
  qualityRating: string | null;
  /** e.g. TIER_250, TIER_1K (field name changed in 2025; both read) */
  messagingLimit: string | null;
};

export type ProviderTemplate = {
  id: string;
  name: string;
  language: string;
  /** APPROVED, PENDING, REJECTED, PAUSED, DISABLED, … */
  status: string;
  /** MARKETING, UTILITY, AUTHENTICATION (others mapped to OTHER by the caller) */
  category: string;
  parameterFormat: "POSITIONAL" | "NAMED";
  components: unknown[];
};

export type TemplateSend = {
  to: string;
  name: string;
  language: string;
  parameterFormat: "POSITIONAL" | "NAMED";
  /** POSITIONAL: values in order; NAMED: {name: value}. Body parameters only. */
  parameters: string[] | Record<string, string>;
};

export type SendResult = { messageId: string };

export interface WhatsAppClient {
  readonly name: "META" | "FAKE";
  /** Live check: the number exists under the WABA and the token can read it. */
  verify(creds: WhatsAppCredentials): Promise<PhoneNumberInfo>;
  /** Subscribe our Meta app to the WABA's webhooks. */
  subscribeApp(creds: WhatsAppCredentials): Promise<void>;
  listTemplates(creds: WhatsAppCredentials): Promise<ProviderTemplate[]>;
  sendTemplate(
    creds: WhatsAppCredentials,
    message: TemplateSend,
  ): Promise<SendResult>;
  /** Free-form text: only inside the 24-hour customer service window (enforced by the caller too). */
  sendText(
    creds: WhatsAppCredentials,
    message: { to: string; body: string },
  ): Promise<SendResult>;
}

/** A Meta API error. `retryable` = try again later (rate limits, temporary faults). */
export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "WhatsAppError";
  }
}

/** Normalised webhook items (one Meta POST can carry several). */
export type WhatsAppWebhookItem =
  | {
      kind: "STATUS";
      wabaId: string;
      phoneNumberId: string | null;
      messageId: string;
      /** sent, delivered, read, failed */
      status: string;
      timestamp: number;
      recipient: string | null;
      errorCode: string | null;
      errorTitle: string | null;
      pricingCategory: string | null;
    }
  | {
      kind: "INBOUND";
      wabaId: string;
      phoneNumberId: string | null;
      messageId: string;
      from: string;
      profileName: string | null;
      timestamp: number;
      type: string;
      text: string | null;
    }
  | {
      kind: "TEMPLATE_STATUS";
      wabaId: string;
      phoneNumberId: null;
      templateId: string | null;
      name: string | null;
      language: string | null;
      status: string;
      timestamp: number;
    };
