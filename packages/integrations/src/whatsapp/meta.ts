import { createHmac, timingSafeEqual } from "node:crypto";
import {
  WhatsAppError,
  type PhoneNumberInfo,
  type ProviderTemplate,
  type SendResult,
  type TemplateSend,
  type WhatsAppClient,
  type WhatsAppCredentials,
  type WhatsAppWebhookItem,
} from "./types";

/**
 * Meta WhatsApp Cloud API over plain fetch (docs checked 2026-11-05). Not yet tried against a live
 * WABA: see docs/IMPLEMENTATION_STATUS.md (M6) for what to verify first.
 */
export const GRAPH_VERSION = "v27.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Error codes that are worth retrying later (third-party sources; confirm live). */
const RETRYABLE = new Set([
  "1",
  "2",
  "4",
  "17",
  "80007",
  "130429",
  "131000",
  "131016",
  "131056",
  "133004",
]);

export function classifyMetaError(
  code: string | number | undefined,
  httpStatus?: number,
): boolean {
  if (code !== undefined && RETRYABLE.has(String(code))) return true;
  return httpStatus === undefined || httpStatus >= 500 || httpStatus === 429;
}

/** HMAC-SHA256 of the raw body with the Meta app secret, sent as `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): boolean {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const expected = createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");
  const given = header.slice("sha256=".length);
  return (
    given.length === expected.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  );
}

export function signMetaWebhook(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
}

type Json = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;

/** Flattens a verified Meta POST into items (messages, statuses, template status updates). */
export function parseMetaWebhook(rawBody: string): WhatsAppWebhookItem[] {
  const body = JSON.parse(rawBody) as Json;
  if (body.object !== "whatsapp_business_account") return [];
  const items: WhatsAppWebhookItem[] = [];
  for (const entry of (body.entry as Json[] | undefined) ?? []) {
    const wabaId = str(entry.id) ?? "";
    for (const change of (entry.changes as Json[] | undefined) ?? []) {
      const value = (change.value as Json | undefined) ?? {};
      if (change.field === "messages") {
        const phoneNumberId = str(
          (value.metadata as Json | undefined)?.phone_number_id,
        );
        const contacts = (value.contacts as Json[] | undefined) ?? [];
        for (const m of (value.messages as Json[] | undefined) ?? []) {
          const from = str(m.from) ?? "";
          const contact = contacts.find((c) => str(c.wa_id) === from);
          items.push({
            kind: "INBOUND",
            wabaId,
            phoneNumberId,
            messageId: str(m.id) ?? "",
            from,
            profileName: str((contact?.profile as Json | undefined)?.name),
            timestamp: Number(m.timestamp ?? 0),
            type: str(m.type) ?? "unknown",
            text:
              str((m.text as Json | undefined)?.body) ??
              str((m.button as Json | undefined)?.text) ??
              str(
                (
                  (m.interactive as Json | undefined)?.button_reply as
                    Json | undefined
                )?.title,
              ),
          });
        }
        for (const st of (value.statuses as Json[] | undefined) ?? []) {
          const error = ((st.errors as Json[] | undefined) ?? [])[0];
          items.push({
            kind: "STATUS",
            wabaId,
            phoneNumberId,
            messageId: str(st.id) ?? "",
            status: str(st.status) ?? "unknown",
            timestamp: Number(st.timestamp ?? 0),
            recipient: str(st.recipient_id),
            errorCode: str(error?.code),
            errorTitle: str(error?.title) ?? str(error?.message),
            pricingCategory: str((st.pricing as Json | undefined)?.category),
          });
        }
      } else if (change.field === "message_template_status_update") {
        items.push({
          kind: "TEMPLATE_STATUS",
          wabaId,
          phoneNumberId: null,
          templateId: str(value.message_template_id),
          name: str(value.message_template_name),
          language: str(value.message_template_language),
          status: str(value.event) ?? "UNKNOWN",
          timestamp: Math.floor(Date.now() / 1000),
        });
      }
    }
  }
  return items;
}

export function placeholders(bodyText: string | null | undefined): string[] {
  const found = [
    ...(bodyText ?? "").matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi),
  ].map((m) => m[1]!);
  return [...new Set(found)];
}

export function templateBody(components: unknown[]): string | null {
  const body = (components as Json[]).find(
    (c) => String(c.type).toUpperCase() === "BODY",
  );
  return str(body?.text);
}

/**
 * Embedded Signup: swaps the code from FB.login (response_type "code") for a business token.
 * Server-side only (needs the app secret). Not yet run against Meta: see the M6 status notes.
 */
export async function exchangeEmbeddedSignupCode(
  input: { appId: string; appSecret: string; code: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const q = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    code: input.code,
  });
  let res: Response;
  try {
    res = await fetchImpl(`${GRAPH}/oauth/access_token?${q}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new WhatsAppError(
      "Couldn't reach Meta. Try again shortly.",
      "NETWORK",
      true,
    );
  }
  const json = (await res.json().catch(() => ({}))) as Json;
  const token = str(json.access_token);
  if (!res.ok || !token) {
    const err = (json.error as Json | undefined) ?? {};
    throw new WhatsAppError(
      str(err.message) ?? "Meta didn't accept the sign-up code.",
      str(err.code) ?? String(res.status),
      false,
      res.status,
    );
  }
  return token;
}

export class MetaWhatsAppClient implements WhatsAppClient {
  readonly name = "META" as const;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${GRAPH}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new WhatsAppError(
        "Couldn't reach WhatsApp. Try again shortly.",
        "NETWORK",
        true,
      );
    }
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const err = (json.error as Json | undefined) ?? {};
      const code = str(err.code) ?? String(res.status);
      // Never echo tokens; Meta's message is safe to show to staff.
      throw new WhatsAppError(
        str(err.message) ?? `WhatsApp error ${code}`,
        code,
        classifyMetaError(code, res.status),
        res.status,
      );
    }
    return json as T;
  }

  async verify(creds: WhatsAppCredentials): Promise<PhoneNumberInfo> {
    const phone = await this.call<Json>(
      creds.accessToken,
      `/${encodeURIComponent(creds.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,whatsapp_business_manager_messaging_limit`,
    );
    // The token must also see the WABA, and the number must belong to it.
    const numbers = await this.call<{ data?: Json[] }>(
      creds.accessToken,
      `/${encodeURIComponent(creds.wabaId)}/phone_numbers?fields=id`,
    );
    if (!(numbers.data ?? []).some((n) => str(n.id) === creds.phoneNumberId))
      throw new WhatsAppError(
        "That phone number isn't in this WhatsApp Business Account.",
        "NUMBER_NOT_IN_WABA",
        false,
      );
    return {
      displayPhone: str(phone.display_phone_number),
      verifiedName: str(phone.verified_name),
      qualityRating: str(phone.quality_rating),
      messagingLimit:
        str(phone.whatsapp_business_manager_messaging_limit) ??
        str(phone.messaging_limit_tier),
    };
  }

  async subscribeApp(creds: WhatsAppCredentials): Promise<void> {
    await this.call(
      creds.accessToken,
      `/${encodeURIComponent(creds.wabaId)}/subscribed_apps`,
      { method: "POST" },
    );
  }

  async listTemplates(creds: WhatsAppCredentials): Promise<ProviderTemplate[]> {
    const out: ProviderTemplate[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({
        fields: "id,name,language,status,category,components,parameter_format",
        limit: "100",
      });
      if (after) q.set("after", after);
      const res = await this.call<{
        data?: Json[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>(
        creds.accessToken,
        `/${encodeURIComponent(creds.wabaId)}/message_templates?${q}`,
      );
      for (const t of res.data ?? [])
        out.push({
          id: str(t.id) ?? "",
          name: str(t.name) ?? "",
          language: str(t.language) ?? "",
          status: str(t.status) ?? "UNKNOWN",
          category: str(t.category) ?? "OTHER",
          parameterFormat:
            String(t.parameter_format ?? "POSITIONAL").toUpperCase() === "NAMED"
              ? "NAMED"
              : "POSITIONAL",
          components: (t.components as unknown[]) ?? [],
        });
      after = res.paging?.next ? (res.paging.cursors?.after ?? null) : null;
      if (!after) break;
    }
    return out;
  }

  async sendTemplate(
    creds: WhatsAppCredentials,
    m: TemplateSend,
  ): Promise<SendResult> {
    const parameters = Array.isArray(m.parameters)
      ? m.parameters.map((text) => ({ type: "text", text }))
      : Object.entries(m.parameters).map(([parameter_name, text]) => ({
          type: "text",
          parameter_name,
          text,
        }));
    const res = await this.call<{ messages?: { id: string }[] }>(
      creds.accessToken,
      `/${encodeURIComponent(creds.phoneNumberId)}/messages`,
      {
        method: "POST",
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: m.to,
          type: "template",
          template: {
            name: m.name,
            language: { code: m.language },
            ...(parameters.length
              ? { components: [{ type: "body", parameters }] }
              : {}),
          },
        },
      },
    );
    const id = res.messages?.[0]?.id;
    if (!id)
      throw new WhatsAppError(
        "WhatsApp didn't return a message id.",
        "NO_ID",
        false,
      );
    return { messageId: id };
  }

  async sendText(
    creds: WhatsAppCredentials,
    m: { to: string; body: string },
  ): Promise<SendResult> {
    const res = await this.call<{ messages?: { id: string }[] }>(
      creds.accessToken,
      `/${encodeURIComponent(creds.phoneNumberId)}/messages`,
      {
        method: "POST",
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: m.to,
          type: "text",
          text: { body: m.body, preview_url: false },
        },
      },
    );
    const id = res.messages?.[0]?.id;
    if (!id)
      throw new WhatsAppError(
        "WhatsApp didn't return a message id.",
        "NO_ID",
        false,
      );
    return { messageId: id };
  }
}
