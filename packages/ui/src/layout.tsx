import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  Info,
  Inbox,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

const alertTones = {
  info: { box: "border-info/30 bg-info-soft text-info", icon: Info },
  success: {
    box: "border-success/30 bg-success-soft text-success",
    icon: CheckCircle2,
  },
  warning: {
    box: "border-warning/30 bg-warning-soft text-warning",
    icon: AlertTriangle,
  },
  danger: { box: "border-danger/30 bg-danger-soft text-danger", icon: XCircle },
} as const;

export type AlertProps = HTMLAttributes<HTMLDivElement> & {
  tone?: keyof typeof alertTones;
  title?: string;
};

/** Inline message. Danger and warning are announced (role="alert"), others politely (role="status"). */
export function Alert({
  tone = "info",
  title,
  className,
  children,
  ...props
}: AlertProps) {
  const { box, icon: Icon } = alertTones[tone];
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-md border px-4 py-3 text-sm",
        box,
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col gap-1 text-foreground">
        {title && <p className="font-semibold">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-surface px-6 py-10 text-center">
      <Icon aria-hidden="true" className="size-8 text-muted" />
      <p className="font-medium text-foreground">{title}</p>
      {description && (
        <p className="max-w-md text-sm text-muted">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "warning" | "danger" | "success";
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
      <p className="text-sm text-muted">{label}</p>
      <p
        className={cn(
          "text-2xl font-semibold",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export type Column<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Hidden below the sm breakpoint. */
  hideOnMobile?: boolean;
  /** Makes the header a sort link (server-side sorting through the URL). */
  sortable?: boolean;
};

export type SortState = { key: string; dir: "asc" | "desc" };

/**
 * Accessible table. Scrolls horizontally inside its card on small screens.
 * - Sorting is server-side: pass `sort` and `sortHref`; sortable headers become links and
 *   carry aria-sort.
 * - `loading` shows skeleton rows, `error` replaces the table, `empty` shows when there are no rows.
 * - Wrap in <ColumnVisibility> to let users hide columns (cells carry data-col).
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  caption,
  loading,
  error,
  sort,
  sortHref,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  caption?: string;
  loading?: boolean;
  error?: ReactNode;
  sort?: SortState;
  sortHref?: (sort: SortState) => string;
}) {
  if (error) return <>{error}</>;
  if (!loading && rows.length === 0 && empty) return <>{empty}</>;
  const colClass = (col: Column<T>) =>
    cn(col.hideOnMobile && "hidden sm:table-cell", col.className);
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table
        className="w-full text-left text-sm"
        aria-busy={loading || undefined}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="border-b border-border bg-background text-xs uppercase tracking-wide text-muted">
          <tr>
            {columns.map((col) => {
              const active = sort?.key === col.key;
              const ariaSort = active
                ? sort?.dir === "asc"
                  ? "ascending"
                  : "descending"
                : undefined;
              const nextDir = active && sort?.dir === "asc" ? "desc" : "asc";
              return (
                <th
                  key={col.key}
                  scope="col"
                  data-col={col.key}
                  aria-sort={col.sortable ? (ariaSort ?? "none") : undefined}
                  className={cn("px-4 py-3 font-medium", colClass(col))}
                >
                  {col.sortable && sortHref ? (
                    <a
                      href={sortHref({ key: col.key, dir: nextDir })}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      {col.header}
                      {active ? (
                        sort?.dir === "asc" ? (
                          <ArrowUp aria-hidden="true" className="size-3" />
                        ) : (
                          <ArrowDown aria-hidden="true" className="size-3" />
                        )
                      ) : (
                        <ArrowUpDown
                          aria-hidden="true"
                          className="size-3 opacity-50"
                        />
                      )}
                    </a>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {loading
            ? Array.from({ length: 3 }, (_, i) => (
                <tr key={`skeleton-${i}`}>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      data-col={col.key}
                      className={cn("px-4 py-3", colClass(col))}
                    >
                      <Skeleton className="h-4 w-full max-w-32" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => (
                <tr key={rowKey(row)} className="align-top">
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      data-col={col.key}
                      className={cn("px-4 py-3", colClass(col))}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

/** Link-based pagination; the page number travels in the URL. */
export function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
}: {
  page: number;
  pageSize: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  if (pages <= 1) return null;
  const link =
    "rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-background";
  return (
    <nav
      aria-label="Pagination"
      className="mt-4 flex items-center justify-between gap-2 text-sm"
    >
      <span className="text-muted">
        Page {page} of {pages} · {total} total
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <a className={link} href={hrefFor(page - 1)}>
            Previous
          </a>
        ) : (
          <span aria-disabled="true" className={cn(link, "opacity-50")}>
            Previous
          </span>
        )}
        {page < pages ? (
          <a className={link} href={hrefFor(page + 1)}>
            Next
          </a>
        ) : (
          <span aria-disabled="true" className={cn(link, "opacity-50")}>
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-border/60", className)}
    />
  );
}

/** Centered card for sign-in style pages. */
export function AuthCard({
  brand,
  title,
  description,
  children,
  footer,
}: {
  brand: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-lg font-semibold text-primary">
          {brand}
        </p>
        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-muted">{description}</p>
          )}
          <div className="mt-6">{children}</div>
        </div>
        {footer && (
          <div className="mt-4 text-center text-sm text-muted">{footer}</div>
        )}
      </div>
    </main>
  );
}
