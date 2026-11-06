/**
 * Payment allocation (D-10). Pure.
 *
 * Default: oldest open invoice first (by issue date, then number). Staff may instead give an
 * explicit split; it must not exceed any invoice's outstanding amount or the payment itself.
 * Whatever is left over becomes member credit.
 */
export type OpenInvoice = {
  id: string;
  issueDate: string;
  number: string;
  outstandingMinor: number;
};

export type AllocationPlan = {
  allocations: { invoiceId: string; amountMinor: number }[];
  creditMinor: number;
};

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationError";
  }
}

export function allocateOldestFirst(
  amountMinor: number,
  invoices: OpenInvoice[],
): AllocationPlan {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new AllocationError("The amount must be a positive number of paise.");
  }
  const ordered = [...invoices]
    .filter((i) => i.outstandingMinor > 0)
    .sort((a, b) =>
      a.issueDate === b.issueDate
        ? a.number.localeCompare(b.number)
        : a.issueDate < b.issueDate
          ? -1
          : 1,
    );
  let left = amountMinor;
  const allocations: AllocationPlan["allocations"] = [];
  for (const invoice of ordered) {
    if (left === 0) break;
    const take = Math.min(left, invoice.outstandingMinor);
    allocations.push({ invoiceId: invoice.id, amountMinor: take });
    left -= take;
  }
  return { allocations, creditMinor: left };
}

export function allocateExplicit(
  amountMinor: number,
  invoices: OpenInvoice[],
  split: { invoiceId: string; amountMinor: number }[],
): AllocationPlan {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new AllocationError("The amount must be a positive number of paise.");
  }
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const seen = new Set<string>();
  let used = 0;
  const allocations: AllocationPlan["allocations"] = [];
  for (const part of split) {
    if (part.amountMinor === 0) continue;
    const invoice = byId.get(part.invoiceId);
    if (!invoice)
      throw new AllocationError(
        "You can only allocate to this member's open invoices.",
      );
    if (seen.has(part.invoiceId))
      throw new AllocationError("Each invoice can appear once.");
    seen.add(part.invoiceId);
    if (!Number.isSafeInteger(part.amountMinor) || part.amountMinor < 0) {
      throw new AllocationError("Allocation amounts must be positive.");
    }
    if (part.amountMinor > invoice.outstandingMinor) {
      throw new AllocationError(
        `Invoice ${invoice.number} only has ${invoice.outstandingMinor} paise outstanding.`,
      );
    }
    used += part.amountMinor;
    allocations.push({
      invoiceId: part.invoiceId,
      amountMinor: part.amountMinor,
    });
  }
  if (used > amountMinor)
    throw new AllocationError("The split adds up to more than the payment.");
  return { allocations, creditMinor: amountMinor - used };
}

/** Invoice status from its total and what has been paid and credited against it. */
export function invoiceStatusFor(input: {
  totalMinor: number;
  allocatedMinor: number;
  creditedMinor: number;
  voided: boolean;
}): "ISSUED" | "PARTIALLY_PAID" | "PAID" | "VOID" {
  if (input.voided) return "VOID";
  const settled = input.allocatedMinor + input.creditedMinor;
  if (settled >= input.totalMinor) return "PAID";
  if (input.allocatedMinor > 0) return "PARTIALLY_PAID";
  return "ISSUED";
}
