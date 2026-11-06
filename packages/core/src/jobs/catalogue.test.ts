import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { parseJob } from "./catalogue";

const valid = {
  tenantId: null,
  actor: { type: "system" },
  idempotencyKey: "ping-abc",
  data: { message: "hello" },
};

describe("job catalogue", () => {
  it("accepts a valid envelope", () => {
    expect(parseJob("system", "system.ping", valid).data.message).toBe("hello");
  });

  it("rejects idempotency keys BullMQ cannot use", () => {
    expect(() =>
      parseJob("system", "system.ping", { ...valid, idempotencyKey: "a:b" }),
    ).toThrow(AppError);
    expect(() =>
      parseJob("system", "system.ping", { ...valid, idempotencyKey: "12345" }),
    ).toThrow(AppError);
  });

  it("every nightly job accepts a tenant-local date and refuses anything else", () => {
    // Regression: engagement.daily once had /^d{4}-.../ (lost backslashes) and refused every date.
    const tenantId = "11111111-1111-4111-8111-111111111111";
    for (const [queue, name] of [
      ["memberships", "memberships.daily"],
      ["payments", "payments.daily"],
      ["classes", "classes.daily"],
      ["growth", "growth.daily"],
      ["engagement", "engagement.daily"],
      ["metrics", "metrics.rollup"],
    ] as const) {
      const env = {
        tenantId,
        actor: { type: "system" },
        idempotencyKey: `${name}-x`,
        data: { date: "2026-11-06" },
      };
      expect(parseJob(queue, name as never, env).data).toEqual({
        date: "2026-11-06",
      });
      expect(() =>
        parseJob(queue, name as never, {
          ...env,
          data: { date: "dddd-dd-dd" },
        }),
      ).toThrow(AppError);
    }
  });

  it("rejects bad data and unknown jobs", () => {
    expect(() =>
      parseJob("system", "system.ping", { ...valid, data: {} }),
    ).toThrow(AppError);
    expect(() =>
      parseJob("system", "system.nope" as "system.ping", valid),
    ).toThrow(/Unknown job/);
    expect(() =>
      parseJob("system", "system.ping", { ...valid, tenantId: "not-a-uuid" }),
    ).toThrow(AppError);
  });
});
