import { randomBytes } from "node:crypto";

/** Pure CRM rules (M5). No database access: unit-tested on their own. */

export const STAGE_CATEGORIES = [
  "NEW",
  "CONTACTED",
  "TRIAL_SCHEDULED",
  "TRIAL_ATTENDED",
  "OFFER_SENT",
  "WON",
  "LOST",
] as const;
export type StageCategory = (typeof STAGE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<StageCategory, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  TRIAL_SCHEDULED: "Trial scheduled",
  TRIAL_ATTENDED: "Trial attended",
  OFFER_SENT: "Offer sent",
  WON: "Won",
  LOST: "Lost",
};

/** The pipeline a gym starts with; they rename, reorder and add stages, each mapped to a category. */
export const DEFAULT_STAGES: { name: string; category: StageCategory }[] =
  STAGE_CATEGORIES.map((category) => ({
    name: CATEGORY_LABEL[category],
    category,
  }));

export const DEFAULT_SOURCES: { name: string; code: string; points: number }[] =
  [
    { name: "Walk-in", code: "walk_in", points: 15 },
    { name: "Phone call", code: "phone", points: 10 },
    { name: "Website", code: "website", points: 10 },
    { name: "Referral", code: "referral", points: 20 },
    { name: "Instagram", code: "instagram", points: 5 },
    { name: "Facebook", code: "facebook", points: 5 },
    { name: "Google", code: "google", points: 5 },
    { name: "Other", code: "other", points: 0 },
  ];

export const DEFAULT_LOST_REASONS = [
  "Price too high",
  "Chose another gym",
  "Too far / timing doesn't suit",
  "Not interested any more",
  "No response",
  "Wrong number / spam",
];

/** Lead status that a stage category implies. */
export function statusForCategory(
  category: StageCategory,
): "OPEN" | "WON" | "LOST" {
  return category === "WON" ? "WON" : category === "LOST" ? "LOST" : "OPEN";
}

/** Categories a lead may be dragged into by hand. WON only comes from a paid membership. */
export function canMoveTo(category: StageCategory): boolean {
  return category !== "WON" && category !== "LOST";
}

/** Funnel position of a category; LOST has no position (-1). */
export function categoryRank(category: StageCategory): number {
  return category === "LOST" ? -1 : STAGE_CATEGORIES.indexOf(category);
}

// --- identity & duplicates -----------------------------------------------------------------

export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

export type ContactKey = { phone: string | null; email: string | null };

/** How a record matches the new contact details: phone, email, both, or not at all. */
export function matchKind(
  a: ContactKey,
  b: ContactKey,
): "both" | "phone" | "email" | null {
  const phone = !!a.phone && a.phone === b.phone;
  const email = !!a.email && a.email === b.email;
  return phone && email ? "both" : phone ? "phone" : email ? "email" : null;
}

// --- assignment ------------------------------------------------------------------------------

/**
 * Round-robin: the next eligible person after the last one given a lead, in a stable order
 * (by user id). If the last person is no longer eligible, the next id after theirs continues
 * the rotation, so nobody is skipped or doubled when the team changes.
 */
export function nextRoundRobin(
  eligible: readonly string[],
  lastUserId: string | null,
): string | null {
  if (eligible.length === 0) return null;
  const sorted = [...new Set(eligible)].sort();
  if (!lastUserId) return sorted[0]!;
  return sorted.find((id) => id > lastUserId) ?? sorted[0]!;
}

// --- scoring (rule-based, transparent) ------------------------------------------------------

export type ScoreInput = {
  sourcePoints: number;
  createdAt: Date;
  now: Date;
  /** A two-way contact happened: an answered call, a meeting, or a reply. */
  responded: boolean;
  trialBooked: boolean;
  trialAttended: boolean;
  trialNoShow: boolean;
  category: StageCategory;
};

export type ScorePart = { rule: string; label: string; points: number };

const DAY = 86_400_000;

/** Score 0–100 with every rule that contributed, so staff see why. Never called a prediction. */
export function scoreLead(input: ScoreInput): {
  score: number;
  parts: ScorePart[];
} {
  const parts: ScorePart[] = [];
  if (input.sourcePoints)
    parts.push({ rule: "source", label: "Source", points: input.sourcePoints });
  const age = input.now.getTime() - input.createdAt.getTime();
  const recency =
    age < 2 * DAY ? 20 : age < 7 * DAY ? 10 : age < 30 * DAY ? 5 : 0;
  if (recency)
    parts.push({
      rule: "recency",
      label:
        age < 2 * DAY
          ? "New in the last 2 days"
          : age < 7 * DAY
            ? "New this week"
            : "New this month",
      points: recency,
    });
  if (input.responded)
    parts.push({ rule: "responded", label: "Talked to us", points: 15 });
  if (input.trialBooked)
    parts.push({ rule: "trial_booked", label: "Trial booked", points: 20 });
  if (input.trialAttended)
    parts.push({
      rule: "trial_attended",
      label: "Came for a trial",
      points: 30,
    });
  if (input.trialNoShow && !input.trialAttended)
    parts.push({ rule: "trial_no_show", label: "Missed a trial", points: -10 });
  if (input.category === "OFFER_SENT")
    parts.push({ rule: "offer", label: "Offer sent", points: 10 });
  const total = parts.reduce((s, p) => s + p.points, 0);
  return { score: Math.max(0, Math.min(100, total)), parts };
}

// --- attribution ------------------------------------------------------------------------------

export type Utm = {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  term?: string | null;
  content?: string | null;
};

export type Touch = {
  at: string;
  via: "STAFF" | "FORM" | "API" | "IMPORT";
  sourceId: string | null;
  campaignId: string | null;
  utm: Utm;
  referrer?: string | null;
};

/** First touch never changes; last touch is the latest enquiry (KPI: attribution model). */
export function mergeTouches(
  current: { first: Touch | null; last: Touch | null },
  next: Touch,
): { first: Touch; last: Touch } {
  return { first: current.first ?? next, last: next };
}

/** Trims UTM values to sane lengths and drops empty ones. */
export function cleanUtm(raw: Record<string, unknown>): Utm {
  const pick = (k: string) => {
    const v = raw[k] ?? raw[`utm_${k}`];
    return typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null;
  };
  return {
    source: pick("source"),
    medium: pick("medium"),
    campaign: pick("campaign"),
    term: pick("term"),
    content: pick("content"),
  };
}

/** utm_source → one of the gym's source codes (case-insensitive; common aliases). */
export function sourceCodeFor(
  utmSource: string | null | undefined,
): string | null {
  const v = (utmSource ?? "").trim().toLowerCase();
  if (!v) return null;
  const aliases: Record<string, string> = {
    fb: "facebook",
    "facebook.com": "facebook",
    meta: "facebook",
    ig: "instagram",
    "instagram.com": "instagram",
    "google.com": "google",
    adwords: "google",
    gads: "google",
  };
  return aliases[v] ?? v.replace(/[^a-z0-9_]+/g, "_");
}

// --- tasks & SLA -------------------------------------------------------------------------------

export function firstContactDue(createdAt: Date, minutes: number): Date {
  return new Date(createdAt.getTime() + minutes * 60_000);
}

export function isOverdue(
  task: { status: string; dueAt: Date },
  now: Date,
): boolean {
  return task.status === "OPEN" && task.dueAt.getTime() < now.getTime();
}

// --- trial pass ---------------------------------------------------------------------------------

export const TRIAL_QR_PREFIX = "GT1.";

/** 22 random base64url characters: no personal data in the QR. */
export function newTrialPassCode(): string {
  return randomBytes(16).toString("base64url");
}

export function parseTrialQr(raw: string): string | null {
  const v = raw.trim();
  if (!v.startsWith(TRIAL_QR_PREFIX)) return null;
  const code = v.slice(TRIAL_QR_PREFIX.length);
  return /^[A-Za-z0-9_-]{22}$/.test(code) ? code : null;
}

// --- API keys --------------------------------------------------------------------------------------

export const API_KEY_SCOPES = ["leads.create"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** `gk_<prefix 12>_<secret 32>`; only the prefix and a SHA-256 of the secret are stored. */
export function parseApiKey(
  raw: string | null | undefined,
): { prefix: string; secret: string } | null {
  const m = /^gk_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{32,64})$/.exec(
    (raw ?? "").trim(),
  );
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}
