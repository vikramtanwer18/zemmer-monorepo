/**
 * Pure WhatsApp rules (M6, D-12, spec Module 11). No database, no clock: callers pass `now`.
 * The send gate is evaluated by the worker at send time, never only when a campaign is created.
 */

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Our tables store E.164 ("+919800000001"); Meta wants and sends bare digits. */
export function toMetaPhone(e164: string): string {
  return e164.replace(/\D/g, "");
}

export function fromMetaPhone(digits: string): string {
  return `+${digits.replace(/\D/g, "")}`;
}

/** Last 4 digits only, for logs and audit (never the full number in logs). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 4 ? "****" : `…${digits.slice(-4)}`;
}

export function withinServiceWindow(
  lastInboundAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!lastInboundAt) return false;
  const age = now.getTime() - lastInboundAt.getTime();
  return age >= 0 && age < SERVICE_WINDOW_MS;
}

/** Lower-case, trimmed, punctuation and repeated spaces removed (Devanagari letters kept). */
export function normalizeKeyword(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A keyword counts only when it is the whole message ("STOP", "stop!", "Band karo"), so a
 * sentence like "don't stop the reminders" never opts anyone out by accident.
 */
export function matchKeyword(
  text: string | null | undefined,
  optOut: readonly string[],
  optIn: readonly string[],
): { kind: "OPT_OUT" | "OPT_IN"; keyword: string } | null {
  if (!text) return null;
  const said = normalizeKeyword(text);
  if (!said || said.length > 40) return null;
  const out = optOut.find((k) => normalizeKeyword(k) === said);
  if (out) return { kind: "OPT_OUT", keyword: out };
  const back = optIn.find((k) => normalizeKeyword(k) === said);
  if (back) return { kind: "OPT_IN", keyword: back };
  return null;
}

export function cleanKeywords(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of raw) {
    const n = normalizeKeyword(k);
    if (n && n.length <= 40 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// --- send gate ------------------------------------------------------------------------------

export type SendCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION" | "OTHER";
export type SendPurpose =
  "CAMPAIGN" | "AUTOMATION" | "NOTIFICATION" | "INBOX" | "TEST";

export const SKIP_REASONS = {
  NOT_ON_PLAN: "The gym's plan doesn't include WhatsApp messaging.",
  ACCOUNT_INACTIVE: "WhatsApp isn't connected for this gym.",
  QUOTA_EXCEEDED: "The plan's monthly WhatsApp message limit is used up.",
  SUPPRESSED: "This number opted out or is blocked.",
  OUTSIDE_WINDOW:
    "Free text is only allowed within 24 hours of the contact's last message. Use a template.",
  TEMPLATE_NOT_APPROVED: "The template isn't approved by WhatsApp (yet).",
  NO_SERVICE_CONSENT: "The contact turned off WhatsApp service messages.",
  NO_MARKETING_CONSENT: "No recorded WhatsApp marketing consent.",
  DAILY_CAP: "Already got the daily maximum of promotional messages.",
  NO_PHONE: "No mobile number on file.",
  CAMPAIGN_CANCELLED: "The campaign was cancelled.",
} as const;

export type SkipReason = keyof typeof SKIP_REASONS;

export type GateInput = {
  /** whatsapp.enabled on the gym's plan, right now. */
  planAllows: boolean;
  accountStatus: "ACTIVE" | "ERROR" | "DISCONNECTED" | null;
  kind: "TEMPLATE" | "TEXT";
  purpose: SendPurpose;
  category: SendCategory;
  templateStatus?: string | null;
  suppressed: boolean;
  /** Only the opt-out/opt-in confirmation reply may go to a suppressed number. */
  bypassSuppression?: boolean;
  /** Latest recorded consent for this contact (WhatsApp channel). */
  consent: { service: boolean; marketing: boolean };
  lastInboundAt: Date | null;
  now: Date;
  /** Promotional messages this number got in the last 24 hours (any campaign or automation). */
  marketingSentLast24h: number;
  marketingDailyCap: number;
  monthlyUsed: number;
  /** null = unlimited. */
  monthlyLimit: number | null;
};

export type GateResult = { ok: true } | { ok: false; reason: SkipReason };

/**
 * Order matters only for the reason shown; any failing check blocks the send.
 * MARKETING templates need marketing consent; UTILITY/AUTHENTICATION (reminders, payment
 * links, receipts) need service consent not revoked; free text needs the 24-hour window.
 * TEST sends go to staff numbers the sender typed in, so consent and the cap don't apply,
 * but suppression still does.
 */
export function evaluateSendGate(g: GateInput): GateResult {
  if (!g.planAllows) return { ok: false, reason: "NOT_ON_PLAN" };
  if (g.accountStatus !== "ACTIVE")
    return { ok: false, reason: "ACCOUNT_INACTIVE" };
  if (g.monthlyLimit !== null && g.monthlyUsed >= g.monthlyLimit)
    return { ok: false, reason: "QUOTA_EXCEEDED" };
  if (g.suppressed && !g.bypassSuppression)
    return { ok: false, reason: "SUPPRESSED" };
  if (g.kind === "TEXT") {
    if (!withinServiceWindow(g.lastInboundAt, g.now))
      return { ok: false, reason: "OUTSIDE_WINDOW" };
  } else if (g.templateStatus !== "APPROVED") {
    return { ok: false, reason: "TEMPLATE_NOT_APPROVED" };
  }
  if (g.purpose === "TEST") return { ok: true };
  const marketing = g.kind === "TEMPLATE" && g.category === "MARKETING";
  if (marketing) {
    if (!g.consent.marketing)
      return { ok: false, reason: "NO_MARKETING_CONSENT" };
    if (g.marketingSentLast24h >= g.marketingDailyCap)
      return { ok: false, reason: "DAILY_CAP" };
  } else if (!g.consent.service && !g.bypassSuppression) {
    return { ok: false, reason: "NO_SERVICE_CONSENT" };
  }
  return { ok: true };
}

/** Consent from the append-only history (latest row per purpose wins). */
export function resolveConsent(
  history: readonly {
    purpose: "SERVICE" | "MARKETING";
    status: "GRANTED" | "REVOKED";
    capturedAt: Date;
  }[],
  defaults: { service: boolean; marketing: boolean },
): { service: boolean; marketing: boolean } {
  const latest = new Map<string, "GRANTED" | "REVOKED">();
  for (const row of [...history].sort(
    (a, b) => a.capturedAt.getTime() - b.capturedAt.getTime(),
  ))
    latest.set(row.purpose, row.status);
  return {
    service: latest.has("SERVICE")
      ? latest.get("SERVICE") === "GRANTED"
      : defaults.service,
    marketing: latest.has("MARKETING")
      ? latest.get("MARKETING") === "GRANTED"
      : defaults.marketing,
  };
}

// --- templates ------------------------------------------------------------------------------

export type TemplateValues = string[] | Record<string, string>;

/** Template body with values filled in, for previews and the message log. */
export function renderTemplateBody(
  bodyText: string | null | undefined,
  values: TemplateValues,
): string {
  if (!bodyText) return "";
  return bodyText.replace(
    /\{\{\s*([a-z0-9_]+)\s*\}\}/gi,
    (whole, key: string) => {
      const v = Array.isArray(values) ? values[Number(key) - 1] : values[key];
      return v === undefined ? whole : v;
    },
  );
}

/**
 * Meta rejects empty parameters and parameters with newlines/tabs or more than 4 spaces in a
 * row; values are flattened so a member's name or a plan name can never break a send.
 */
export function cleanParameter(
  value: string | number | null | undefined,
): string {
  const s = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim();
  return (s || "-").slice(0, 1000);
}

/** Values for the template's placeholders, positional (["1","2"]) or named. */
export function templateParameters(
  variables: readonly string[],
  parameterFormat: string,
  values: Record<string, string | number | null | undefined>,
): TemplateValues {
  if (parameterFormat === "NAMED") {
    const out: Record<string, string> = {};
    for (const v of variables) out[v] = cleanParameter(values[v]);
    return out;
  }
  return [...variables]
    .sort((a, b) => Number(a) - Number(b))
    .map((v) => cleanParameter(values[v]));
}

/** Messaging-limit tier → unique business-initiated recipients per rolling 24 hours. */
export function messagingLimitCount(
  tier: string | null | undefined,
): number | null {
  if (!tier) return 250;
  const t = tier.toUpperCase();
  if (t.includes("UNLIMITED")) return null;
  const m = /TIER_(\d+)(K)?/.exec(t);
  if (!m) return 250;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

// --- delivery statuses ----------------------------------------------------------------------

const RANK = { QUEUED: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4 } as const;

/**
 * Meta may deliver "read" before "delivered", or repeat a status: only move forward. "failed"
 * wins over sent/delivered (Meta can fail a message after accepting it) but never over read.
 */
export function nextOutboundStatus(
  current: string,
  incoming: "sent" | "delivered" | "read" | "failed" | string,
): "SENT" | "DELIVERED" | "READ" | "FAILED" | null {
  const target = incoming.toUpperCase();
  if (current === "FAILED" || current === "SKIPPED") {
    // A late "delivered"/"read" proves the message arrived after all.
    return current === "FAILED" && (target === "DELIVERED" || target === "READ")
      ? (target as "DELIVERED" | "READ")
      : null;
  }
  if (target === "FAILED") return current === "READ" ? null : "FAILED";
  if (!(target in RANK)) return null;
  const from = RANK[current as keyof typeof RANK] ?? 0;
  const to = RANK[target as keyof typeof RANK];
  return to > from ? (target as "SENT" | "DELIVERED" | "READ") : null;
}
