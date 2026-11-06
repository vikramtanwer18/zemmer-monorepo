import {
  AlertOctagon,
  CalendarDays,
  ChevronRight,
  CreditCard,
  Dumbbell,
  Home,
  QrCode,
  User,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

/** Breadcrumb trail; the last item is the current page. */
export function Breadcrumbs({
  items,
}: {
  items: { label: string; href?: string }[];
}) {
  return (
    <nav aria-label="Breadcrumb" className="mb-3 text-sm">
      <ol className="flex flex-wrap items-center gap-1 text-muted">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li
              key={`${item.label}-${index}`}
              className="flex items-center gap-1"
            >
              {item.href && !last ? (
                <a
                  href={item.href}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {item.label}
                </a>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn(last && "text-foreground")}
                >
                  {item.label}
                </span>
              )}
              {!last && (
                <ChevronRight aria-hidden="true" className="size-3.5" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** For failed loads: says what went wrong and offers a way forward. */
export function ErrorState({
  title = "Something went wrong",
  description = "Please try again. If it keeps happening, contact support.",
  action,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-2 rounded-lg border border-danger/30 bg-danger-soft px-6 py-10 text-center"
    >
      <AlertOctagon aria-hidden="true" className="size-8 text-danger" />
      <p className="font-medium text-foreground">{title}</p>
      <div className="max-w-md text-sm text-muted">{description}</div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export const MOBILE_TAB_ICONS = {
  home: Home,
  card: QrCode,
  classes: CalendarDays,
  payments: CreditCard,
  profile: User,
  train: Dumbbell,
} satisfies Record<string, LucideIcon>;

/** Bottom tab bar for the member PWA. Server-renderable; pass the current path. */
export function MobileTabBar({
  items,
  currentPath,
}: {
  items: { href: string; label: string; icon: keyof typeof MOBILE_TAB_ICONS }[];
  currentPath: string;
}) {
  return (
    <nav
      aria-label="Member app"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex max-w-md">
        {items.map((item) => {
          const Icon = MOBILE_TAB_ICONS[item.icon];
          const active = currentPath === item.href;
          return (
            <li key={item.href} className="flex-1">
              <a
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium",
                  active ? "text-primary" : "text-muted",
                )}
              >
                <Icon aria-hidden="true" className="size-5" />
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
