import { crc32, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { toXlsx } from "./xlsx";

/** Reads a ZIP through its central directory and checks every entry's CRC. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const buf = Buffer.from(bytes);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localName = buf.readUInt16LE(offset + 26);
    const data = inflateRawSync(
      buf.subarray(offset + 30 + localName, offset + 30 + localName + size),
    );
    expect(crc32(data)).toBe(crc);
    out.set(name, data.toString("utf8"));
    p += 46 + nameLen;
  }
  return out;
}

describe("toXlsx", () => {
  it("writes a valid package: numbers as numbers, text as inline strings (never formulas)", () => {
    const files = unzip(
      toXlsx(
        "Revenue: Nov/Dec",
        ["Member", "Amount (INR)"],
        [
          ['=HYPERLINK("x")', 1234.5],
          ["Asha & Co <b>", null],
          ["Ok\u0001", 7],
        ],
      ),
    );
    expect([...files.keys()].sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain('<c r="B2" s="0"><v>1234.5</v></c>');
    expect(sheet).toContain("=HYPERLINK(&quot;x&quot;)</t>"); // a string, not an <f> formula
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("Asha &amp; Co &lt;b&gt;");
    expect(sheet).not.toContain("\u0001");
    expect(sheet).toContain('<row r="3"><c r="A3" t="inlineStr"'); // empty cell skipped
    expect(files.get("xl/workbook.xml")).toContain('name="Revenue  Nov Dec"');
  });
});
