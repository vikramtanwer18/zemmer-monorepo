"use client";

import {
  BarChart3,
  Bell,
  Sparkles,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Dumbbell,
  ListChecks,
  ListTodo,
  Magnet,
  HeartPulse,
  Activity,
  Gift,
  Trophy,
  Megaphone,
  MessagesSquare,
  Workflow,
  ScanLine,
  FileText,
  Wallet,
  Contact,
  ClipboardList,
  CreditCard,
  LayoutDashboard,
  Menu,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "./cn";

/** Icons by name, so server components can pass nav items (functions can't cross to the client). */
export const NAV_ICONS = {
  dashboard: LayoutDashboard,
  branches: Building2,
  staff: Users,
  settings: Settings,
  audit: ClipboardList,
  plans: CreditCard,
  support: ShieldCheck,
  account: UserCog,
  platform: SlidersHorizontal,
  members: Contact,
  invoices: FileText,
  payments: Wallet,
  bell: Bell,
  scan: ScanLine,
  attendance: ListChecks,
  classes: CalendarDays,
  pt: Dumbbell,
  myday: ClipboardCheck,
  leads: Magnet,
  tasks: ListTodo,
  inbox: MessagesSquare,
  campaigns: Megaphone,
  automations: Workflow,
  retention: HeartPulse,
  fitness: Activity,
  engagement: Trophy,
  rewards: Gift,
  reports: BarChart3,
  copilot: Sparkles,
} satisfies Record<string, LucideIcon>;

export type NavItem = {
  href: string;
  label: string;
  icon: keyof typeof NAV_ICONS;
};

export type AppShellProps = {
  brand: string;
  /** Small label under the brand, e.g. the tenant name. */
  subtitle?: string;
  nav: NavItem[];
  /** The current path, from the server (keeps this component free of router hooks). */
  currentPath: string;
  /** Header slots: tenant/branch switchers, profile menu, … */
  headerStart?: ReactNode;
  headerEnd?: ReactNode;
  /** Full-width notices above the content (trial, suspension, support access). */
  banner?: ReactNode;
  /** Preview inside another page: no <main> landmark and no skip link. */
  embedded?: boolean;
  children: ReactNode;
};

function isActive(currentPath: string, href: string) {
  return href === "/"
    ? currentPath === "/"
    : currentPath === href || currentPath.startsWith(`${href}/`);
}

/** Responsive layout: sidebar on desktop, slide-in drawer on mobile. */
export function AppShell({
  brand,
  subtitle,
  nav,
  currentPath,
  headerStart,
  headerEnd,
  banner,
  embedded = false,
  children,
}: AppShellProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const navList = (
    <nav aria-label="Main" className="flex flex-col gap-1 p-3">
      {nav.map((item) => {
        const Icon = NAV_ICONS[item.icon];
        const active = isActive(currentPath, item.href);
        return (
          <a
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
              active
                ? "bg-primary text-primary-foreground"
                : "text-foreground hover:bg-background",
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {item.label}
          </a>
        );
      })}
    </nav>
  );

  const brandBlock = (
    <div className="flex flex-col px-6 py-4">
      <span className="text-lg font-semibold text-primary">{brand}</span>
      {subtitle && (
        <span className="truncate text-xs text-muted">{subtitle}</span>
      )}
    </div>
  );

  return (
    <div className="min-h-dvh">
      {!embedded && (
        <a
          href="#main"
          className="sr-only rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50"
        >
          Skip to content
        </a>
      )}

      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-border bg-surface lg:flex">
        {brandBlock}
        {navList}
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-surface shadow-lg">
            <div className="flex items-center justify-between pr-3">
              {brandBlock}
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="rounded-md p-2 hover:bg-background"
              >
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>
            {navList}
          </div>
        </div>
      )}

      <div className="flex min-h-dvh flex-col lg:pl-64">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface px-3 sm:px-6">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="rounded-md p-2 hover:bg-background lg:hidden"
          >
            <Menu aria-hidden="true" className="size-5" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {headerStart}
          </div>
          <div className="flex items-center gap-2">{headerEnd}</div>
        </header>
        {banner}
        {embedded ? (
          <div className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</div>
        ) : (
          <main id="main" className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </main>
        )}
      </div>
    </div>
  );
}
