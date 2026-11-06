/**
 * Helpers for Playwright tests: read emails from Mailpit (dev SMTP) and create fixtures directly
 * in the development database. Never used against real data.
 */
import { randomBytes } from "node:crypto";

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

type MailpitSummary = { ID: string; Created: string; Subject: string };

/** Waits for the newest email to `to` (optionally matching the subject) and returns its text. */
export async function waitForEmail(
  to: string,
  options: { subject?: RegExp; after?: Date; timeoutMs?: number } = {},
): Promise<{ subject: string; text: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const query = encodeURIComponent(`to:"${to}"`);
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${query}&limit=20`);
    if (res.ok) {
      const body = (await res.json()) as { messages?: MailpitSummary[] };
      const match = (body.messages ?? []).find(
        (m) =>
          (!options.subject || options.subject.test(m.Subject)) &&
          (!options.after || new Date(m.Created) >= options.after),
      );
      if (match) {
        const full = (await (
          await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)
        ).json()) as {
          Subject: string;
          Text: string;
        };
        return { subject: full.Subject, text: full.Text };
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No email to ${to} within the timeout`);
}

export function firstLink(text: string): string {
  const match = /https?:\/\/[^\s<>"]+/.exec(text);
  if (!match) throw new Error("No link in email");
  return match[0];
}

export function otpCode(text: string): string {
  const match = /\b(\d{6})\b/.exec(text);
  if (!match) throw new Error("No code in email");
  return match[1]!;
}

/** A unique, obviously-fake address for one test run. */
export function testEmail(label: string): string {
  return `${label}-${Date.now()}-${randomBytes(3).toString("hex")}@e2e.test`;
}

export function testPassword(): string {
  return `E2e-${randomBytes(12).toString("base64url")}`;
}

/**
 * Playwright global setup: clears the development Redis rate-limit counters, so repeated local
 * e2e runs (all from one IP) don't trip the sign-up and sign-in limits.
 */
export async function clearRateLimits(): Promise<void> {
  const { Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  try {
    for (const pattern of ["gym:rl:*"]) {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          500,
        );
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== "0");
    }
  } finally {
    redis.disconnect();
  }
}
