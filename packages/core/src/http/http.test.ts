import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "../errors";
import { handleRoute, requestIdFrom } from "./index";

const ok = () => Promise.resolve({ userId: "u1" });

describe("handleRoute", () => {
  it("validates the JSON body and returns { ok, data }", async () => {
    const res = await handleRoute(
      new Request("http://x/api/t", {
        method: "POST",
        body: JSON.stringify({ name: "Asha" }),
      }),
      {
        input: z.object({ name: z.string().min(2) }),
        context: ok,
        handler: async ({ input, ctx }) => ({
          hello: input.name,
          by: ctx.userId,
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { hello: "Asha", by: "u1" },
    });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("maps validation errors to 422 with field messages", async () => {
    const res = await handleRoute(
      new Request("http://x/api/t", { method: "POST", body: "{}" }),
      {
        input: z.object({ name: z.string({ error: "Name is required." }) }),
        context: ok,
        handler: async () => null,
      },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        fields: { name: ["Name is required."] },
      },
    });
  });

  it("reads GET input from the query string", async () => {
    const res = await handleRoute(new Request("http://x/api/t?page=3"), {
      input: z.object({ page: z.coerce.number() }),
      context: ok,
      handler: async ({ input }) => input.page,
    });
    expect(await res.json()).toEqual({ ok: true, data: 3 });
  });

  it("refuses before validating when the context throws (401/403/402)", async () => {
    for (const [code, status] of [
      ["AUTH_REQUIRED", 401],
      ["FORBIDDEN", 403],
      ["ENTITLEMENT_REQUIRED", 402],
    ] as const) {
      const res = await handleRoute(
        new Request("http://x/api/t", { method: "POST", body: "not json" }),
        {
          input: z.object({}),
          context: () => Promise.reject(new AppError(code, "No.")),
          handler: async () => null,
        },
      );
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it("hides unexpected errors behind a generic 500", async () => {
    const res = await handleRoute(new Request("http://x/api/t"), {
      context: ok,
      handler: async () => {
        throw new Error("relation app.secret does not exist");
      },
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("app.secret");
  });

  it("rejects a body that isn't JSON", async () => {
    const res = await handleRoute(
      new Request("http://x/api/t", { method: "POST", body: "{oops" }),
      {
        input: z.object({}),
        context: ok,
        handler: async () => null,
      },
    );
    expect(res.status).toBe(422);
  });
});

describe("requestIdFrom", () => {
  it("keeps a sane incoming id and replaces a malicious one", () => {
    expect(requestIdFrom(new Headers({ "x-request-id": "abc-123-def" }))).toBe(
      "abc-123-def",
    );
    const replaced = requestIdFrom(
      new Headers({ "x-request-id": "bad id <script>" }),
    );
    expect(replaced).toMatch(/^[0-9a-f-]{36}$/);
  });
});
