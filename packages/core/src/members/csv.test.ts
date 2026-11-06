import { describe, expect, it } from "vitest";
import { csvField, parseCsv, toCsv } from "./csv";

describe("CSV", () => {
  it("parses quotes, doubled quotes, commas and CRLF", () => {
    expect(parseCsv('a,b,c\r\n"x, y","say ""hi""",\n\n1,2,3')).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', ""],
      ["1", "2", "3"],
    ]);
  });

  it("strips a UTF-8 BOM (Excel exports)", () => {
    expect(parseCsv("\uFEFFfirst_name\nAsha")).toEqual([
      ["first_name"],
      ["Asha"],
    ]);
  });

  it("neutralises spreadsheet formulas on export", () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField("+91987")).toBe("'+91987");
    expect(csvField("plain")).toBe("plain");
  });

  it("round-trips", () => {
    const rows = [
      ["a", "b, c"],
      ['he said "x"', "line\nbreak"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
