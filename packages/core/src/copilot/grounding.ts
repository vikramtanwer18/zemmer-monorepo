/**
 * Number grounding (M8 guardrail): every figure in a Copilot answer must come from a tool result.
 * We collect every number the tools returned (raw and in the forms a writer would use: rupees from
 * paise, percentages from ratios, rounded, 1–2 decimals) and flag answer numbers not among them.
 * Dates, times and small structural numbers ("top 5", "7 days") are ignored.
 */

const SMALL = 10;

function variants(n: number): string[] {
  const out = new Set<string>();
  const add = (v: number) => {
    if (!Number.isFinite(v)) return;
    out.add(String(Math.round(v)));
    out.add(v.toFixed(1));
    out.add(v.toFixed(2));
    out.add(String(Math.round(v * 10) / 10));
    out.add(String(Math.round(v * 100) / 100));
    out.add(String(Math.floor(v)));
    out.add(String(Math.ceil(v)));
  };
  add(n);
  add(Math.abs(n));
  add(n / 100); // paise → rupees
  add(Math.abs(n) / 100);
  if (Math.abs(n) <= 5) add(Math.abs(n) * 100); // ratio or change → percent (ratios only)
  add(n / 60); // minutes → hours
  return [...out].map(normalise);
}

/** "1,23,456.50" / "₹1,234" / "45.0" → canonical text ("123456.5", "1234", "45"). */
function normalise(text: string): string {
  const n = Number(text.replace(/[₹,\s]/g, ""));
  if (!Number.isFinite(n)) return text;
  return String(Math.round(n * 100) / 100);
}

const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g, // 2026-11-06, 2026-11-06T10:30
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, // 06/11/2026
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?(?:\s+\d{4})?\b/gi, // 6 Nov 2026
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi, // Nov 6, 2026
  /\b(?:19|20)\d{2}\b/g, // a bare year
  /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, // 10:30, 6:00 pm
  /\b[A-Z]{1,6}-?\d{2,}[A-Z0-9-]*\b/g, // codes like INV-0012, M00042, GYM-2026-0001
];

/** Numbers as written in free text (not inside dates, times or codes). */
export function numbersIn(text: string): string[] {
  let t = text;
  for (const p of DATE_PATTERNS) t = t.replace(p, " ");
  const found = t.match(/(?:₹\s?)?-?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return found.map((s) => s.replace(/^₹\s?/, "")).filter((s) => /\d/.test(s));
}

/** Every number in a tool result (JSON values, and numbers inside its strings). */
export function groundedSet(results: unknown[]): Set<string> {
  const set = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "number") for (const s of variants(v)) set.add(s);
    else if (typeof v === "string")
      for (const s of numbersIn(v))
        for (const x of variants(Number(s.replace(/,/g, "")))) set.add(x);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  results.forEach(walk);
  return set;
}

/** Answer numbers that no tool returned (and that aren't in the question itself). */
export function ungroundedNumbers(
  answer: string,
  results: unknown[],
  question = "",
): string[] {
  const allowed = groundedSet([...results, question]);
  const out: string[] = [];
  for (const raw of numbersIn(answer)) {
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    if (Number.isInteger(value) && Math.abs(value) <= SMALL) continue;
    if (!allowed.has(normalise(raw))) out.push(raw);
  }
  return [...new Set(out)];
}
