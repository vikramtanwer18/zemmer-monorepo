import type { Prisma, TenantTransaction } from "@gym/db";
import { recordAudit } from "../audit";
import { requirePermission, type AuthContext } from "../authz";
import { AppError, isAppError } from "../errors";
import { fromDbDate } from "../time/dates";
import type { Entitlements } from "../entitlements";
import { createMemberTx, memberName } from "./service";

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Escapes a value for CSV, and neutralises spreadsheet formulas (CSV injection). */
export function csvField(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

export const IMPORT_COLUMNS = [
  "first_name",
  "last_name",
  "phone",
  "email",
  "date_of_birth",
  "gender",
  "branch_code",
  "marketing_email",
  "marketing_whatsapp",
] as const;

export const IMPORT_MAX_ROWS = 5000;

export type ImportRowResult = {
  row: number;
  status: "ok" | "error" | "duplicate";
  message?: string;
  memberCode?: string;
};
export type ImportSummary = {
  dryRun: boolean;
  total: number;
  imported: number;
  errors: number;
  duplicates: number;
  rows: ImportRowResult[];
};

const yes = (v: string | undefined) =>
  ["yes", "y", "true", "1"].includes((v ?? "").trim().toLowerCase());

/**
 * Validates (and, unless dry-run, imports) a member CSV. Each row is checked with the same rules
 * as the staff form; invalid and duplicate rows are reported and skipped, valid rows imported.
 * `runRow` gives each row its own transaction, so one bad row never undoes the others.
 */
export async function importMembers(
  ctx: AuthContext,
  ent: Entitlements,
  csv: string,
  options: {
    dryRun: boolean;
    runRow: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
  },
): Promise<ImportSummary> {
  requirePermission(ctx, "members.import");
  const rows = parseCsv(csv);
  const [header, ...data] = rows;
  if (!header) throw new AppError("VALIDATION_FAILED", "The file is empty.");
  const columns = header.map((h) => h.trim().toLowerCase());
  for (const required of ["first_name", "branch_code"]) {
    if (!columns.includes(required))
      throw new AppError(
        "VALIDATION_FAILED",
        `Missing column "${required}". Use the template.`,
      );
  }
  if (data.length > IMPORT_MAX_ROWS)
    throw new AppError(
      "VALIDATION_FAILED",
      `At most ${IMPORT_MAX_ROWS} rows per file.`,
    );
  const branches = await options.runRow((tx) =>
    tx.branch.findMany({ where: { status: "ACTIVE" } }),
  );
  const branchByCode = new Map(
    branches.map((b) => [b.code.toUpperCase(), b.id]),
  );

  const summary: ImportSummary = {
    dryRun: options.dryRun,
    total: data.length,
    imported: 0,
    errors: 0,
    duplicates: 0,
    rows: [],
  };
  for (const [index, cells] of data.entries()) {
    const rowNumber = index + 2;
    const get = (name: (typeof IMPORT_COLUMNS)[number]) => {
      const i = columns.indexOf(name);
      return i >= 0 ? (cells[i] ?? "").trim() : "";
    };
    const branchId = branchByCode.get(get("branch_code").toUpperCase());
    if (!branchId) {
      summary.errors++;
      summary.rows.push({
        row: rowNumber,
        status: "error",
        message: `Unknown branch code "${get("branch_code")}".`,
      });
      continue;
    }
    const input = {
      firstName: get("first_name"),
      lastName: get("last_name") || undefined,
      phone: get("phone") || undefined,
      email: get("email") || undefined,
      dateOfBirth: get("date_of_birth") || undefined,
      gender: get("gender").toUpperCase() || undefined,
      homeBranchId: branchId,
      marketingEmail: yes(get("marketing_email")),
      marketingWhatsapp: yes(get("marketing_whatsapp")),
    };
    try {
      const member = await options.runRow(async (tx) => {
        const created = await createMemberTx(tx, ctx, ent, input, "IMPORT");
        if (options.dryRun) throw new DryRunRollback(created.memberCode);
        return created;
      });
      summary.imported++;
      summary.rows.push({
        row: rowNumber,
        status: "ok",
        memberCode: member.memberCode,
      });
    } catch (err) {
      if (err instanceof DryRunRollback) {
        summary.imported++;
        summary.rows.push({ row: rowNumber, status: "ok" });
      } else if (
        isAppError(err) &&
        err.code === "CONFLICT" &&
        (err.details as { duplicates?: unknown[] } | undefined)?.duplicates
      ) {
        summary.duplicates++;
        summary.rows.push({
          row: rowNumber,
          status: "duplicate",
          message: err.message,
        });
      } else if (
        isAppError(err) &&
        (err.code === "VALIDATION_FAILED" ||
          err.code === "QUOTA_EXCEEDED" ||
          err.code === "FORBIDDEN")
      ) {
        summary.errors++;
        const fields = err.fields
          ? Object.values(err.fields).flat().join(" ")
          : "";
        summary.rows.push({
          row: rowNumber,
          status: "error",
          message: fields || err.message,
        });
      } else {
        throw err;
      }
    }
  }
  return summary;
}

/** Thrown to roll a dry-run row back after it passed every check, including the database ones. */
class DryRunRollback extends Error {
  constructor(readonly memberCode: string) {
    super("dry run");
  }
}

/** Member export rows (permission `members.export`, branch-scoped). */
export async function exportMembersCsv(
  tx: TenantTransaction,
  ctx: AuthContext,
  where: Prisma.MemberProfileWhereInput,
) {
  requirePermission(ctx, "members.export");
  const members = await tx.memberProfile.findMany({
    where,
    include: {
      homeBranch: { select: { code: true } },
      memberships: {
        orderBy: { endDate: "desc" },
        take: 1,
        include: { plan: { select: { name: true } } },
      },
    },
    orderBy: { memberCode: "asc" },
    take: 50_000,
  });
  const rows: (string | number | null)[][] = [
    [
      "member_code",
      "first_name",
      "last_name",
      "phone",
      "email",
      "branch_code",
      "status",
      "joined_on",
      "latest_plan",
      "latest_status",
      "latest_end_date",
    ],
    ...members.map((m) => [
      m.memberCode,
      m.firstName,
      m.lastName,
      m.phone,
      m.email,
      m.homeBranch.code,
      m.status,
      m.joinedAt.toISOString().slice(0, 10),
      m.memberships[0]?.plan.name ?? null,
      m.memberships[0]?.status ?? null,
      m.memberships[0] ? fromDbDate(m.memberships[0].endDate) : null,
    ]),
  ];
  await recordAudit(tx, ctx, {
    action: "member.exported",
    entityType: "MemberProfile",
    meta: { count: members.length },
  });
  return {
    csv: toCsv(rows),
    count: members.length,
    names: members.slice(0, 3).map(memberName),
  };
}
