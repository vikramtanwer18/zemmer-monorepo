import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { GST_STATES } from "../gst";
import { fromDbDate } from "../time/dates";
import { amountInWords } from "./numbering";

/**
 * Invoice PDF (D-11). Title "Tax Invoice" for GST-registered suppliers, "Bill / Receipt"
 * otherwise. Only immutable invoice content is printed (no payment status), so the file is
 * generated once and kept.
 *
 * Standard PDF fonts can't draw "₹" or non-Latin scripts; amounts print as "Rs." and other
 * characters are replaced. An embedded Unicode font is a follow-up (status doc).
 */
export type InvoiceForPdf = {
  number: string;
  documentType: "TAX_INVOICE" | "BILL";
  issueDate: Date;
  dueDate: Date;
  currency: string;
  pricesIncludeTax: boolean;
  placeOfSupply: string | null;
  taxableMinor: bigint | number;
  cgstMinor: bigint | number;
  sgstMinor: bigint | number;
  igstMinor: bigint | number;
  totalMinor: bigint | number;
  supplier: unknown;
  recipient: unknown;
  lines: {
    description: string;
    sacCode: string | null;
    quantity: number;
    unitPriceMinor: bigint | number;
    discountMinor: bigint | number;
    taxableMinor: bigint | number;
    cgstRateBps: number;
    sgstRateBps: number;
    igstRateBps: number;
    cgstMinor: bigint | number;
    sgstMinor: bigint | number;
    igstMinor: bigint | number;
    totalMinor: bigint | number;
  }[];
};

const n = (v: bigint | number) => Number(v);
const PRIMARY = rgb(0x20 / 255, 0x42 / 255, 0x89 / 255);
const MUTED = rgb(0.36, 0.39, 0.46);

/** WinAnsi-safe text. */
function safe(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/₹/g, "Rs.")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "?");
}

export function formatRupees(minor: number, currency = "INR"): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const rupees = Math.floor(abs / 100).toLocaleString("en-IN");
  const prefix = currency === "INR" ? "Rs. " : `${currency} `;
  return `${sign}${prefix}${rupees}.${String(abs % 100).padStart(2, "0")}`;
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export async function renderInvoicePdf(
  invoice: InvoiceForPdf,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(
    `${invoice.documentType === "TAX_INVOICE" ? "Tax Invoice" : "Bill"} ${invoice.number}`,
  );
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595.28, 841.89]); // A4
  const margin = 40;
  const width = page.getWidth() - margin * 2;
  let y = page.getHeight() - margin;

  const text = (
    p: PDFPage,
    s: string,
    x: number,
    yy: number,
    opts: {
      size?: number;
      f?: PDFFont;
      color?: ReturnType<typeof rgb>;
      align?: "left" | "right";
      maxWidth?: number;
    } = {},
  ) => {
    const size = opts.size ?? 9;
    const f = opts.f ?? font;
    let value = safe(s);
    if (opts.maxWidth && f.widthOfTextAtSize(value, size) > opts.maxWidth) {
      // Too long for its column: cut and mark with "...".
      while (
        value.length > 1 &&
        f.widthOfTextAtSize(`${value}...`, size) > opts.maxWidth
      )
        value = value.slice(0, -1);
      value = `${value}...`;
    }
    const dx = opts.align === "right" ? f.widthOfTextAtSize(value, size) : 0;
    p.drawText(value, {
      x: x - dx,
      y: yy,
      size,
      font: f,
      color: opts.color ?? rgb(0.04, 0.1, 0.2),
    });
  };

  const supplier = invoice.supplier as Record<string, string | null>;
  const recipient = invoice.recipient as Record<string, string | null>;
  const isTax = invoice.documentType === "TAX_INVOICE";
  const intra = n(invoice.igstMinor) === 0;

  // Header
  text(page, isTax ? "TAX INVOICE" : "BILL / RECEIPT", margin, y, {
    size: 16,
    f: bold,
    color: PRIMARY,
  });
  text(page, `No. ${invoice.number}`, margin + width, y, {
    size: 11,
    f: bold,
    align: "right",
  });
  y -= 16;
  text(page, `Date: ${fromDbDate(invoice.issueDate)}`, margin + width, y, {
    align: "right",
  });
  y -= 12;
  text(page, `Due: ${fromDbDate(invoice.dueDate)}`, margin + width, y, {
    align: "right",
  });
  y -= 22;

  // Parties
  const colRight = margin + width / 2 + 10;
  text(page, "From", margin, y, { f: bold, color: MUTED });
  text(page, "Billed to", colRight, y, { f: bold, color: MUTED });
  y -= 13;
  const supplierLines = [
    supplier.legalName ?? supplier.displayName,
    supplier.displayName !== supplier.legalName
      ? `(${supplier.displayName})`
      : null,
    supplier.branch ? `Branch: ${supplier.branch}` : null,
    supplier.address,
    supplier.stateCode
      ? `State: ${GST_STATES[supplier.stateCode] ?? ""} (${supplier.stateCode})`
      : null,
    isTax && supplier.gstin ? `GSTIN: ${supplier.gstin}` : null,
    supplier.phone ? `Phone: ${supplier.phone}` : null,
  ].filter(Boolean) as string[];
  const recipientLines = [
    recipient.name,
    recipient.memberCode ? `Member ${recipient.memberCode}` : null,
    recipient.address,
    recipient.phone,
    recipient.email,
  ].filter(Boolean) as string[];
  let ly = y;
  for (const line of supplierLines) {
    text(page, line, margin, ly, { maxWidth: width / 2 - 10 });
    ly -= 12;
  }
  let ry = y;
  for (const line of recipientLines) {
    text(page, line, colRight, ry, { maxWidth: width / 2 - 10 });
    ry -= 12;
  }
  y = Math.min(ly, ry) - 8;
  if (isTax && invoice.placeOfSupply) {
    text(
      page,
      `Place of supply: ${GST_STATES[invoice.placeOfSupply] ?? ""} (${invoice.placeOfSupply})`,
      margin,
      y,
    );
    y -= 12;
  }
  text(
    page,
    invoice.pricesIncludeTax ? "Prices include tax." : "Prices exclude tax.",
    margin,
    y,
    { color: MUTED },
  );
  y -= 18;

  // Lines table
  const cols = isTax
    ? [
        { h: "Description", x: margin, w: 200 },
        { h: "SAC", x: margin + 205, w: 45 },
        { h: "Taxable", x: margin + 330, w: 75, right: true },
        {
          h: intra ? "CGST + SGST" : "IGST",
          x: margin + 430,
          w: 85,
          right: true,
        },
        { h: "Amount", x: margin + width, w: 70, right: true },
      ]
    : [
        { h: "Description", x: margin, w: 330 },
        { h: "Qty", x: margin + 380, w: 30, right: true },
        { h: "Amount", x: margin + width, w: 90, right: true },
      ];
  page.drawRectangle({
    x: margin,
    y: y - 4,
    width,
    height: 16,
    color: rgb(0.95, 0.96, 0.98),
  });
  for (const c of cols)
    text(page, c.h, c.x + (c.right ? 0 : 4), y, {
      f: bold,
      align: c.right ? "right" : "left",
    });
  y -= 18;
  for (const line of invoice.lines) {
    if (y < 140) {
      page = pdf.addPage([595.28, 841.89]);
      y = page.getHeight() - margin;
    }
    const discount = n(line.discountMinor);
    if (isTax) {
      text(page, line.description, margin + 4, y, { maxWidth: 196 });
      text(page, line.sacCode ?? "", margin + 209, y);
      text(
        page,
        formatRupees(n(line.taxableMinor), invoice.currency),
        margin + 330,
        y,
        { align: "right" },
      );
      const tax = intra
        ? `${formatRupees(n(line.cgstMinor) + n(line.sgstMinor), invoice.currency)} (${pct(line.cgstRateBps)}+${pct(line.sgstRateBps)})`
        : `${formatRupees(n(line.igstMinor), invoice.currency)} (${pct(line.igstRateBps)})`;
      text(page, tax, margin + 430, y, { align: "right", size: 8 });
      text(
        page,
        formatRupees(n(line.totalMinor), invoice.currency),
        margin + width,
        y,
        { align: "right" },
      );
    } else {
      text(page, line.description, margin + 4, y, { maxWidth: 326 });
      text(page, String(line.quantity), margin + 380, y, { align: "right" });
      text(
        page,
        formatRupees(n(line.totalMinor), invoice.currency),
        margin + width,
        y,
        { align: "right" },
      );
    }
    y -= 12;
    if (discount > 0) {
      text(
        page,
        `Discount: ${formatRupees(discount, invoice.currency)} (before tax)`,
        margin + 4,
        y,
        { size: 8, color: MUTED },
      );
      y -= 11;
    }
  }
  y -= 6;
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + width, y },
    thickness: 0.5,
    color: MUTED,
  });
  y -= 16;

  // Totals
  const totals: [string, number][] = isTax
    ? [
        ["Taxable value", n(invoice.taxableMinor)],
        ...(intra
          ? ([
              ["CGST", n(invoice.cgstMinor)],
              ["SGST", n(invoice.sgstMinor)],
            ] as [string, number][])
          : ([["IGST", n(invoice.igstMinor)]] as [string, number][])),
      ]
    : [];
  for (const [label, value] of totals) {
    text(page, label, margin + width - 150, y, {
      align: "right",
      color: MUTED,
    });
    text(page, formatRupees(value, invoice.currency), margin + width, y, {
      align: "right",
    });
    y -= 13;
  }
  text(page, "Total", margin + width - 150, y, {
    align: "right",
    f: bold,
    size: 11,
  });
  text(
    page,
    formatRupees(n(invoice.totalMinor), invoice.currency),
    margin + width,
    y,
    { align: "right", f: bold, size: 11 },
  );
  y -= 18;
  text(
    page,
    `Amount in words: ${amountInWords(n(invoice.totalMinor), invoice.currency)}`,
    margin,
    y,
    { maxWidth: width },
  );
  y -= 28;
  if (!isTax) {
    text(
      page,
      "The supplier is not registered under GST; no tax is charged.",
      margin,
      y,
      { color: MUTED },
    );
    y -= 12;
  }
  text(
    page,
    "This is a computer-generated document and does not need a signature.",
    margin,
    y,
    { color: MUTED, size: 8 },
  );
  return pdf.save();
}
