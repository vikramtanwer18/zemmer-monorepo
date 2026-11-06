import { describe, expect, it } from "vitest";
import { memoryFakeStore } from "../src/payments/fake";
import {
  classifyMetaError,
  exchangeEmbeddedSignupCode,
  FakeWhatsAppClient,
  fakeWebhooks,
  MetaWhatsAppClient,
  parseMetaWebhook,
  placeholders,
  signMetaWebhook,
  verifyMetaSignature,
  WhatsAppError,
} from "../src/whatsapp";

const creds = {
  wabaId: "1001",
  phoneNumberId: "2002",
  accessToken: "EAAGtoken",
};

describe("Meta webhook signature", () => {
  it("accepts the right HMAC, refuses anything else", () => {
    const body = fakeWebhooks.inbound({
      wabaId: "1001",
      phoneNumberId: "2002",
      from: "919800000001",
      text: "hi",
    });
    const sig = signMetaWebhook(body, "app-secret");
    expect(verifyMetaSignature(body, sig, "app-secret")).toBe(true);
    expect(verifyMetaSignature(body, sig, "other-secret")).toBe(false);
    expect(verifyMetaSignature(`${body} `, sig, "app-secret")).toBe(false);
    expect(
      verifyMetaSignature(body, sig.replace("sha256=", ""), "app-secret"),
    ).toBe(false);
    expect(verifyMetaSignature(body, null, "app-secret")).toBe(false);
    expect(verifyMetaSignature(body, sig, "")).toBe(false);
  });
});

describe("webhook parsing", () => {
  it("normalises inbound messages and statuses (with errors and pricing)", () => {
    const inbound = parseMetaWebhook(
      fakeWebhooks.inbound({
        wabaId: "1001",
        phoneNumberId: "2002",
        from: "919800000001",
        text: "STOP",
        name: "Asha",
      }),
    );
    expect(inbound).toEqual([
      expect.objectContaining({
        kind: "INBOUND",
        wabaId: "1001",
        phoneNumberId: "2002",
        from: "919800000001",
        text: "STOP",
        profileName: "Asha",
        type: "text",
      }),
    ]);
    const failed = parseMetaWebhook(
      fakeWebhooks.status({
        wabaId: "1001",
        phoneNumberId: "2002",
        messageId: "wamid.X",
        status: "failed",
        errorCode: "131026",
      }),
    );
    expect(failed[0]).toMatchObject({
      kind: "STATUS",
      messageId: "wamid.X",
      status: "failed",
      errorCode: "131026",
      pricingCategory: "utility",
    });
    expect(
      parseMetaWebhook(JSON.stringify({ object: "page", entry: [] })),
    ).toEqual([]);
    const tpl = parseMetaWebhook(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "1001",
            changes: [
              {
                field: "message_template_status_update",
                value: {
                  event: "APPROVED",
                  message_template_id: 9,
                  message_template_name: "x",
                  message_template_language: "en",
                },
              },
            ],
          },
        ],
      }),
    );
    expect(tpl[0]).toMatchObject({
      kind: "TEMPLATE_STATUS",
      templateId: "9",
      name: "x",
      status: "APPROVED",
    });
  });

  it("finds template placeholders in body order", () => {
    expect(placeholders("Hi {{1}}, {{2}} on {{1}}")).toEqual(["1", "2"]);
    expect(placeholders("Hi {{ first_name }} from {{gym}}")).toEqual([
      "first_name",
      "gym",
    ]);
    expect(placeholders(null)).toEqual([]);
  });
});

describe("Meta client request shapes", () => {
  function stub(responses: { status?: number; json: unknown }[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init: init ?? {} });
      const r = responses.shift() ?? { json: {} };
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    }) as typeof fetch;
    return { calls, client: new MetaWhatsAppClient(fetchImpl) };
  }

  it("sends positional and named template parameters in Meta's format", async () => {
    const { calls, client } = stub([
      { json: { messages: [{ id: "wamid.1" }] } },
      { json: { messages: [{ id: "wamid.2" }] } },
    ]);
    await client.sendTemplate(creds, {
      to: "919800000001",
      name: "renewal",
      language: "en",
      parameterFormat: "POSITIONAL",
      parameters: ["Asha", "5 Dec"],
    });
    await client.sendTemplate(creds, {
      to: "919800000001",
      name: "offer",
      language: "en",
      parameterFormat: "NAMED",
      parameters: { first_name: "Asha" },
    });
    expect(calls[0]!.url).toBe(
      "https://graph.facebook.com/v27.0/2002/messages",
    );
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: "Bearer EAAGtoken",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919800000001",
      type: "template",
      template: {
        name: "renewal",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Asha" },
              { type: "text", text: "5 Dec" },
            ],
          },
        ],
      },
    });
    expect(
      JSON.parse(String(calls[1]!.init.body)).template.components[0].parameters,
    ).toEqual([{ type: "text", parameter_name: "first_name", text: "Asha" }]);
  });

  it("maps Meta errors to retryable or permanent, never exposing the token", async () => {
    const { client } = stub([
      {
        status: 400,
        json: { error: { code: 131026, message: "Message undeliverable" } },
      },
      {
        status: 429,
        json: { error: { code: 130429, message: "Rate limit hit" } },
      },
    ]);
    const e1 = await client
      .sendText(creds, { to: "1", body: "x" })
      .catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(WhatsAppError);
    expect(e1).toMatchObject({ code: "131026", retryable: false });
    expect(String((e1 as Error).message)).not.toContain("EAAG");
    const e2 = await client
      .sendText(creds, { to: "1", body: "x" })
      .catch((e: unknown) => e);
    expect(e2).toMatchObject({ code: "130429", retryable: true });
    expect(classifyMetaError("131047", 400)).toBe(false);
    expect(classifyMetaError("999", 503)).toBe(true);
  });

  it("verify checks that the number belongs to the WABA", async () => {
    const { client } = stub([
      {
        json: {
          display_phone_number: "+91 98000 00001",
          quality_rating: "GREEN",
          whatsapp_business_manager_messaging_limit: "TIER_250",
        },
      },
      { json: { data: [{ id: "other" }] } },
    ]);
    await expect(client.verify(creds)).rejects.toMatchObject({
      code: "NUMBER_NOT_IN_WABA",
    });
  });
});

describe("embedded signup", () => {
  it("exchanges the code server-side and never leaks the secret in errors", async () => {
    const urls: string[] = [];
    const ok = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ access_token: "EAAGbiz" }), {
        status: 200,
      });
    }) as typeof fetch;
    expect(
      await exchangeEmbeddedSignupCode(
        { appId: "1", appSecret: "s3cret", code: "c0de" },
        ok,
      ),
    ).toBe("EAAGbiz");
    expect(urls[0]).toBe(
      "https://graph.facebook.com/v27.0/oauth/access_token?client_id=1&client_secret=s3cret&code=c0de",
    );
    const bad = (async () =>
      new Response(
        JSON.stringify({ error: { code: 100, message: "Invalid code" } }),
        { status: 400 },
      )) as typeof fetch;
    const e = await exchangeEmbeddedSignupCode(
      { appId: "1", appSecret: "s3cret", code: "x" },
      bad,
    ).catch((err: unknown) => err);
    expect(e).toMatchObject({ code: "100", retryable: false });
    expect(String((e as Error).message)).not.toContain("s3cret");
  });
});

describe("fake client", () => {
  it("records sends, injects failures, refuses a wrong token", async () => {
    const fake = new FakeWhatsAppClient(memoryFakeStore());
    await expect(
      fake.verify({ ...creds, accessToken: "wrong-token" }),
    ).rejects.toMatchObject({ code: "190" });
    await fake.failNext("2002", "130429");
    await expect(
      fake.sendText(creds, { to: "1", body: "a" }),
    ).rejects.toMatchObject({ retryable: true });
    const ok = await fake.sendText(creds, { to: "1", body: "a" });
    expect(ok.messageId).toMatch(/^wamid\.FAKE/);
    expect(await fake.sent("2002")).toHaveLength(1);
    expect(
      (await fake.listTemplates(creds)).some((t) => t.category === "MARKETING"),
    ).toBe(true);
  });
});
