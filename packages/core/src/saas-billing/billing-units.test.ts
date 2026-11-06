import { describe, expect, it } from "vitest";
import { announcementApplies } from "./announcements";
import {
  INTERNAL_PATHS,
  signInternalRequest,
  verifyInternalRequest,
} from "./tenant-view";

const base = {
  audience: "ALL" as const,
  planCodes: [] as string[],
  statuses: [] as string[],
  startsAt: new Date("2026-11-01T00:00:00Z"),
  endsAt: null as Date | null,
  archivedAt: null as Date | null,
};
const now = new Date("2026-11-05T10:00:00Z");
const gym = { planCode: "growth", status: "ACTIVE" };

describe("announcementApplies", () => {
  it("shows ALL announcements in their window only", () => {
    expect(announcementApplies(base, gym, now)).toBe(true);
    expect(
      announcementApplies(
        { ...base, startsAt: new Date("2026-11-06T00:00:00Z") },
        gym,
        now,
      ),
    ).toBe(false);
    expect(announcementApplies({ ...base, endsAt: now }, gym, now)).toBe(false);
    expect(announcementApplies({ ...base, archivedAt: now }, gym, now)).toBe(
      false,
    );
  });

  it("targets plans and statuses", () => {
    expect(
      announcementApplies(
        { ...base, audience: "PLANS", planCodes: ["growth"] },
        gym,
        now,
      ),
    ).toBe(true);
    expect(
      announcementApplies(
        { ...base, audience: "PLANS", planCodes: ["pro"] },
        gym,
        now,
      ),
    ).toBe(false);
    expect(
      announcementApplies(
        { ...base, audience: "PLANS", planCodes: ["pro"] },
        { planCode: null, status: null },
        now,
      ),
    ).toBe(false);
    expect(
      announcementApplies(
        { ...base, audience: "STATUSES", statuses: ["PAST_DUE", "GRACE"] },
        { ...gym, status: "GRACE" },
        now,
      ),
    ).toBe(true);
    expect(
      announcementApplies(
        { ...base, audience: "STATUSES", statuses: ["PAST_DUE"] },
        gym,
        now,
      ),
    ).toBe(false);
  });
});

describe("signed internal requests (web → admin)", () => {
  const secret = "internal-secret-for-tests-0123456789";
  const path = INTERNAL_PATHS.checkout;
  const body = JSON.stringify({ tenantId: "t", userId: "u", priceId: "p" });
  const t = 1_800_000_000_000;

  it("accepts a fresh, matching signature", () => {
    const h = signInternalRequest(secret, path, body, t);
    expect(
      verifyInternalRequest(
        secret,
        path,
        body,
        {
          timestamp: h["x-internal-timestamp"],
          signature: h["x-internal-signature"],
        },
        t + 1000,
      ),
    ).toBe(true);
  });

  it("refuses a changed body, path, secret, or an old timestamp", () => {
    const h = signInternalRequest(secret, path, body, t);
    const headers = {
      timestamp: h["x-internal-timestamp"],
      signature: h["x-internal-signature"],
    };
    expect(
      verifyInternalRequest(
        secret,
        path,
        body.replace('"p"', '"q"'),
        headers,
        t,
      ),
    ).toBe(false);
    expect(
      verifyInternalRequest(secret, INTERNAL_PATHS.cancel, body, headers, t),
    ).toBe(false);
    expect(
      verifyInternalRequest(
        "another-secret-0123456789abcdef",
        path,
        body,
        headers,
        t,
      ),
    ).toBe(false);
    expect(
      verifyInternalRequest(secret, path, body, headers, t + 6 * 60_000),
    ).toBe(false);
    expect(
      verifyInternalRequest(
        secret,
        path,
        body,
        { timestamp: null, signature: null },
        t,
      ),
    ).toBe(false);
    expect(
      verifyInternalRequest(
        secret,
        path,
        body,
        { ...headers, signature: "00" },
        t,
      ),
    ).toBe(false);
  });
});
