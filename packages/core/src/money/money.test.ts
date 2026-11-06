import { describe, expect, it } from "vitest";
import {
  add,
  minorToMajorString,
  parseMajorToMinor,
  formatMoney,
  money,
  percentOf,
  splitInclusive,
  subtract,
} from "./index";

describe("money", () => {
  it("rejects non-integer amounts", () => {
    expect(() => money(10.5)).toThrow(RangeError);
  });

  it("18% of ₹1,000 is exactly ₹180", () => {
    expect(percentOf(money(100_000), 1800)).toEqual(money(18_000));
  });

  it("rounds half a paisa up", () => {
    // 18% of 25 paise = 4.5 paise
    expect(percentOf(money(25), 1800).amountMinor).toBe(5);
    // 18% of 22 paise = 3.96 paise
    expect(percentOf(money(22), 1800).amountMinor).toBe(4);
  });

  it("a tax-inclusive split adds back up exactly", () => {
    for (const gross of [1, 99, 1_180, 99_999, 1_234_567, 9_007_199_254_740]) {
      const { net, tax } = splitInclusive(money(gross), 1800);
      expect(add(net, tax).amountMinor).toBe(gross);
    }
    expect(splitInclusive(money(118_000), 1800)).toEqual({
      net: money(100_000),
      tax: money(18_000),
    });
  });

  it("adds and subtracts", () => {
    expect(add(money(150), money(50))).toEqual(money(200));
    expect(subtract(money(150), money(200))).toEqual(money(-50));
  });

  it("throws when mixing INR and USD", () => {
    expect(() => add(money(100, "INR"), money(100, "USD"))).toThrow(TypeError);
    expect(() => subtract(money(100, "INR"), money(100, "USD"))).toThrow(
      TypeError,
    );
  });

  it("formats with the en-IN locale", () => {
    expect(formatMoney(money(10_000_000))).toBe("₹1,00,000.00");
    expect(formatMoney(money(5))).toBe("₹0.05");
  });
});

describe("parseMajorToMinor", () => {
  it.each([
    ["1180", 118_000],
    ["1,180.50", 118_050],
    ["₹ 99.9", 9_990],
    ["0.05", 5],
    ["INR 10", 1_000],
  ])("%s → %i paise", (input, expected) => {
    expect(parseMajorToMinor(input)).toBe(expected);
  });

  it.each(["", "-5", "1.234", "abc", "1e3", "10.", ".5"])(
    "rejects %j",
    (input) => {
      expect(parseMajorToMinor(input)).toBeNull();
    },
  );

  it("formats back for form fields", () => {
    expect(minorToMajorString(118_050)).toBe("1180.50");
    expect(minorToMajorString(5)).toBe("0.05");
  });
});
