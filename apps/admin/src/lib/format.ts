/** Operator console formatting: India time, rupees. */
export function inr(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(minor / 100);
}

export function at(d: Date | null | undefined): string {
  return d
    ? d.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

export function onDay(d: Date | null | undefined): string {
  return d
    ? d.toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
      })
    : "—";
}
