import { describe, expect, it } from "vitest";
import {
  fromBase64Url,
  msUntilNextStep,
  parsePassCode,
  passCodeAt,
  passMac,
  stepInWindow,
  timeStepAt,
  toBase64Url,
} from "./pass-code";

// Fixed vectors, computed independently with node:crypto createHmac (not with this module), so
// the PWA and the server provably agree on the algorithm.
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i);
const VECTORS = [
  {
    passId: "AAAAAAAAAAAAAAAAAAAAAA",
    step: 59_000_000,
    mac: "MVbXKfbJRA4Q4ShR",
  },
  { passId: "Zz09_-abcdefghijklmnop", step: 1, mac: "P7egWolXmRb1uh_R" },
];

describe("pass code (D-09)", () => {
  it("matches the fixed HMAC-SHA256 test vectors", async () => {
    for (const v of VECTORS) {
      expect(await passMac(SECRET, v.passId, v.step)).toBe(v.mac);
    }
  });

  it("uses 30-second steps", () => {
    expect(timeStepAt(0)).toBe(0);
    expect(timeStepAt(29_999)).toBe(0);
    expect(timeStepAt(30_000)).toBe(1);
    expect(msUntilNextStep(30_000)).toBe(30_000);
    expect(msUntilNextStep(59_000)).toBe(1_000);
  });

  it("builds and parses the passId.timeStep.mac payload", async () => {
    const now = 59_000_000 * 30_000 + 5_000;
    const { code, timeStep } = await passCodeAt(
      SECRET,
      VECTORS[0]!.passId,
      now,
    );
    expect(timeStep).toBe(59_000_000);
    expect(code).toBe("AAAAAAAAAAAAAAAAAAAAAA.59000000.MVbXKfbJRA4Q4ShR");
    expect(parsePassCode(` ${code}\n`)).toEqual({
      passId: VECTORS[0]!.passId,
      timeStep: 59_000_000,
      mac: "MVbXKfbJRA4Q4ShR",
    });
  });

  it("rejects anything that isn't a pass code", () => {
    for (const bad of [
      "",
      "hello",
      "AAAAAAAAAAAAAAAAAAAAAA.59000000",
      "AAAAAAAAAAAAAAAAAAAAA.59000000.MVbXKfbJRA4Q4ShR", // 21-char id
      "AAAAAAAAAAAAAAAAAAAAAA.-1.MVbXKfbJRA4Q4ShR",
      "AAAAAAAAAAAAAAAAAAAAAA.1.MVbXKfbJRA4Q4Sh", // short mac
      "AAAAAAAAAAAAAAAAAAAAAA.1.MVbXKfbJRA4Q4ShR.extra",
      "https://evil.test/?x=1",
    ]) {
      expect(parsePassCode(bad), bad).toBeNull();
    }
  });

  it("accepts one step of clock drift either way, not two", () => {
    const now = 1_000 * 30_000 + 10;
    expect(stepInWindow(1_000, now)).toBe(true);
    expect(stepInWindow(999, now)).toBe(true);
    expect(stepInWindow(1_001, now)).toBe(true);
    expect(stepInWindow(998, now)).toBe(false);
    expect(stepInWindow(1_002, now)).toBe(false);
  });

  it("base64url round-trips", () => {
    const bytes = Uint8Array.from([0, 255, 62, 63, 1, 2, 3]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(
      Array.from(bytes),
    );
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/);
  });
});
