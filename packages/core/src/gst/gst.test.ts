import { describe, expect, it } from "vitest";
import { taxSettingsSchema } from "../tenancy/schemas";
import { checkGstin, gstinCheckChar } from "./index";

describe("GSTIN validation", () => {
  // Two published sample GSTINs, plus one built from a body and its computed check character.
  const built = `08ABCDE1234F1Z${gstinCheckChar("08ABCDE1234F1Z")}`;
  it.each(["27AAPFU0939F1ZV", "29AAGCB7383J1Z4", built])(
    "accepts %s",
    (gstin) => {
      expect(checkGstin(gstin)).toMatchObject({
        valid: true,
        stateCode: gstin.slice(0, 2),
      });
    },
  );

  it("normalises case and whitespace", () => {
    expect(checkGstin(" 27aapfu0939f1zv ").valid).toBe(true);
  });

  it("rejects a wrong check character", () => {
    expect(checkGstin("27AAPFU0939F1ZA")).toEqual({
      valid: false,
      reason: "checksum",
    });
  });

  it("rejects a single changed character in the body", () => {
    expect(checkGstin("27AAPFU0938F1ZV")).toEqual({
      valid: false,
      reason: "checksum",
    });
  });

  it("rejects an unknown state code", () => {
    const body = "99AAPFU0939F1Z";
    expect(checkGstin(body + gstinCheckChar(body))).toEqual({
      valid: false,
      reason: "state",
    });
  });

  it.each([
    "",
    "27AAPFU0939F1Z",
    "27AAPFU0939F1ZVX",
    "2AAPFU0939F1ZVV",
    "27AAPFU0939F1YV",
  ])("rejects malformed %j", (gstin) => {
    expect(checkGstin(gstin)).toEqual({ valid: false, reason: "format" });
  });

  it("requires the GSTIN state to match the chosen state", () => {
    const result = taxSettingsSchema.safeParse({
      gstRegistered: "on",
      gstin: "27AAPFU0939F1ZV",
      stateCode: "08",
      pricesIncludeTax: "on",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["gstin"]);
  });

  it("drops the GSTIN when not registered", () => {
    const result = taxSettingsSchema.parse({
      gstin: "27AAPFU0939F1ZV",
      stateCode: "27",
    });
    expect(result).toMatchObject({
      gstRegistered: false,
      gstin: null,
      pricesIncludeTax: false,
    });
  });
});
