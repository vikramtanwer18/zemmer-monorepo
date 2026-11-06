/**
 * Rotating QR codes for the member pass (D-09). Shared by the member PWA (which draws the code,
 * offline) and the server (which checks it), so this file uses only Web Crypto and plain
 * TypeScript: no Node modules, no server imports.
 *
 * Payload: `passId.timeStep.mac`
 *   passId    opaque random id (22 base64url chars, no personal data)
 *   timeStep  floor(unix seconds / 30)
 *   mac       first 12 bytes of HMAC-SHA256(secret, "passId|timeStep"), base64url (16 chars)
 */
export const PASS_STEP_SECONDS = 30;
export const PASS_MAC_BYTES = 12;
/** Codes from this many steps either side of the server's clock are accepted (clock drift). */
export const PASS_STEP_TOLERANCE = 1;

const PASS_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAC_RE = /^[A-Za-z0-9_-]{16}$/;
const STEP_RE = /^\d{1,12}$/;

export type ParsedPassCode = { passId: string; timeStep: number; mac: string };

export function timeStepAt(epochMs: number): number {
  return Math.floor(epochMs / 1000 / PASS_STEP_SECONDS);
}

/** Milliseconds until the code for `epochMs` changes. */
export function msUntilNextStep(epochMs: number): number {
  const stepMs = PASS_STEP_SECONDS * 1000;
  return stepMs - (epochMs % stepMs);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function isPassId(value: string): boolean {
  return PASS_ID_RE.test(value);
}

/** The truncated HMAC for (passId, timeStep). */
export async function passMac(
  secret: Uint8Array,
  passId: string,
  timeStep: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${passId}|${timeStep}`),
  );
  return toBase64Url(new Uint8Array(sig).slice(0, PASS_MAC_BYTES));
}

/** The QR payload to show at `epochMs`. */
export async function passCodeAt(
  secret: Uint8Array,
  passId: string,
  epochMs: number,
): Promise<{ code: string; timeStep: number }> {
  const timeStep = timeStepAt(epochMs);
  const mac = await passMac(secret, passId, timeStep);
  return { code: `${passId}.${timeStep}.${mac}`, timeStep };
}

/** Splits a scanned payload; null when it isn't one of ours. Never throws. */
export function parsePassCode(raw: string): ParsedPassCode | null {
  const parts = raw.trim().split(".");
  if (parts.length !== 3) return null;
  const [passId, step, mac] = parts as [string, string, string];
  if (!PASS_ID_RE.test(passId) || !STEP_RE.test(step) || !MAC_RE.test(mac))
    return null;
  const timeStep = Number(step);
  if (!Number.isSafeInteger(timeStep)) return null;
  return { passId, timeStep, mac };
}

/** Is `timeStep` within the accepted window around the server's current step? */
export function stepInWindow(timeStep: number, nowMs: number): boolean {
  return Math.abs(timeStep - timeStepAt(nowMs)) <= PASS_STEP_TOLERANCE;
}
