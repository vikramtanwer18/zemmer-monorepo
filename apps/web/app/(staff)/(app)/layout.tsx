import {
  isTenantWritable,
  permissionSet,
  type PermissionKey,
} from "@gym/core/authz";
import { isFeatureEnabled, type BooleanFeature } from "@gym/core/entitlements";
import { listMyNotifications } from "@gym/core/notifications";
import { announcementsForTenant } from "@gym/core/saas-billing";
import { entitlementsFor, listMyTenants } from "@gym/core/tenancy";
import { Alert, AppShell, Button, type NavItem } from "@gym/ui";
import { headers } from "next/headers";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { signOutAction } from "../(auth)/actions";
import { Bell as BellIcon } from "lucide-react";
import { BranchSwitcher } from "./branch-switcher";

const NAV: (NavItem & {
  permission?: PermissionKey;
  feature?: BooleanFeature;
})[] = [
  {
    href: "/",
    label: "Dashboard",
    icon: "dashboard",
    permission: "dashboard.view",
  },
  {
    href: "/my-day",
    label: "My day",
    icon: "myday",
    permission: "clients.view",
  },
  {
    href: "/scan",
    label: "Scan",
    icon: "scan",
    permission: "attendance.scan",
  },
  {
    href: "/attendance",
    label: "Check-ins",
    icon: "attendance",
    permission: "attendance.view",
  },
  {
    href: "/classes",
    label: "Classes",
    icon: "classes",
    permission: "classes.view",
  },
  {
    href: "/pt",
    label: "Personal training",
    icon: "pt",
    permission: "pt.manage",
  },
  {
    href: "/branches",
    label: "Branches",
    icon: "branches",
    permission: "branches.view",
  },
  {
    href: "/members",
    label: "Members",
    icon: "members",
    permission: "members.view",
  },
  {
    href: "/leads",
    label: "Leads",
    icon: "leads",
    permission: "leads.view",
    feature: "crm.enabled",
  },
  {
    href: "/tasks",
    label: "Tasks",
    icon: "tasks",
    permission: "tasks.manage",
    feature: "crm.enabled",
  },
  // --- M6
  {
    href: "/inbox",
    label: "WhatsApp inbox",
    icon: "inbox",
    permission: "messaging.send",
    feature: "whatsapp.enabled",
  },
  {
    href: "/campaigns",
    label: "Campaigns",
    icon: "campaigns",
    permission: "marketing.send",
    feature: "whatsapp.enabled",
  },
  {
    href: "/automations",
    label: "Automations",
    icon: "automations",
    permission: "automations.approve",
    feature: "automation.enabled",
  },
  {
    href: "/retention",
    label: "Retention",
    icon: "retention",
    permission: "retention.view",
  },
  // --- M7
  {
    href: "/fitness",
    label: "Fitness",
    icon: "fitness",
    permission: "fitness.manage",
    feature: "workouts.enabled",
  },
  {
    href: "/engagement",
    label: "Engagement",
    icon: "engagement",
    permission: "engagement.manage",
  },
  {
    href: "/engagement/redemptions",
    label: "Reward pickups",
    icon: "rewards",
    permission: "rewards.fulfil",
    feature: "rewards.enabled",
  },
  {
    href: "/plans",
    label: "Plans",
    icon: "plans",
    permission: "memberships.view",
  },
  {
    href: "/invoices",
    label: "Invoices",
    icon: "invoices",
    permission: "billing.view",
  },
  {
    href: "/payments",
    label: "Payments",
    icon: "payments",
    permission: "billing.view",
  },
  {
    href: "/reports",
    label: "Reports",
    icon: "reports",
    permission: "reports.view",
  },
  {
    href: "/copilot",
    label: "Copilot",
    icon: "copilot",
    permission: "ai.use",
    feature: "ai.copilot",
  },
  { href: "/staff", label: "Staff", icon: "staff", permission: "staff.view" },
  {
    href: "/settings",
    label: "Settings",
    icon: "settings",
    permission: "settings.view",
  },
  {
    href: "/audit-log",
    label: "Audit log",
    icon: "audit",
    permission: "audit.view",
  },
  { href: "/account", label: "My account", icon: "account" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left until `date` (never negative). */
function daysUntil(date: Date): number {
  return Math.max(Math.ceil((date.getTime() - Date.now()) / DAY_MS), 0);
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const path = (await headers()).get("x-pathname") ?? "/";
  const state = await requireReady(path);
  const { ctx, access, user } = state;
  const permissions = permissionSet(ctx);
  const ent = await entitlementsFor(services().deps, ctx.tenantId);
  // Navigation mirrors permissions for convenience only; every page and action re-checks.
  const nav = NAV.filter(
    (item) =>
      (!item.permission || permissions.has(item.permission)) &&
      (!item.feature || isFeatureEnabled(ent, item.feature)),
  );
  const tenants = await listMyTenants(services().db, user.id);
  const { unread } = await listMyNotifications(
    services().db,
    ctx.tenantId,
    user.id,
    1,
  );

  const allBranches = access.roles.some((r) => r.branchId === null);
  const branchOptions = access.branches.filter(
    (b) => allBranches || access.roles.some((r) => r.branchId === b.id),
  );

  const sub = access.subscription;
  const writable = isTenantWritable(ctx);
  // Platform notices (never block the page if they can't be read).
  const announcements = await announcementsForTenant(
    services().db,
    ctx.tenantId,
  ).catch(() => []);
  const trialDays =
    sub?.status === "TRIALING" && sub.trialEndsAt
      ? daysUntil(sub.trialEndsAt)
      : null;

  const banner = (
    <div className="flex flex-col gap-2 px-4 pt-4 sm:px-6 lg:px-8 empty:hidden">
      {!writable && (
        <Alert tone="warning" title="Read-only">
          {ctx.tenantStatus === "SUSPENDED"
            ? "This gym has been suspended by the platform. You can view your data but can't make changes."
            : "Your subscription is not active, so changes are disabled. Your data is safe."}
        </Alert>
      )}
      {writable && (sub?.status === "PAST_DUE" || sub?.status === "GRACE") && (
        <Alert tone="warning" title="Subscription payment overdue">
          {sub.status === "GRACE" && sub.graceEndsAt
            ? `Changes turn off in ${daysUntil(sub.graceEndsAt)} day${daysUntil(sub.graceEndsAt) === 1 ? "" : "s"} unless the payment goes through. `
            : "Razorpay will try again. "}
          {permissions.has("subscription.manage") ? (
            <a className="font-medium underline" href="/settings/plan">
              Check billing
            </a>
          ) : (
            "Please tell the gym owner."
          )}
        </Alert>
      )}
      {!writable &&
        sub?.status === "SUSPENDED" &&
        permissions.has("subscription.manage") && (
          <Alert tone="info">
            <a className="font-medium underline" href="/settings/plan">
              Pick a plan and pay
            </a>{" "}
            to switch everything back on.
          </Alert>
        )}
      {announcements.map((a) => (
        <Alert key={a.id} tone="info" title={a.title}>
          {a.body}
        </Alert>
      ))}
      {writable && trialDays !== null && (
        <Alert tone="info">
          Free trial of the {sub?.planName} plan: {trialDays} day
          {trialDays === 1 ? "" : "s"} left.
        </Alert>
      )}
      {access.activeSupportSessions.map((s) => (
        <Alert
          key={s.id}
          tone="warning"
          title="Platform support has read-only access"
        >
          Until{" "}
          {s.expiresAt.toLocaleTimeString("en-IN", {
            timeZone: ctx.timezone,
            timeStyle: "short",
          })}
          . Reason: {s.reason}
        </Alert>
      ))}
    </div>
  );

  return (
    <AppShell
      brand={services().brand}
      subtitle={access.tenant.displayName}
      nav={nav}
      currentPath={path}
      banner={banner}
      headerStart={
        <div className="flex min-w-0 items-center gap-2">
          <span className="hidden truncate text-sm font-semibold sm:inline">
            {access.tenant.displayName}
          </span>
          {tenants.length > 1 && (
            <a href="/select-tenant" className="text-xs text-primary underline">
              Switch gym
            </a>
          )}
          {branchOptions.length > 0 && (
            <BranchSwitcher
              current={state.session.activeBranchId ?? "all"}
              allowAll={allBranches}
              branches={branchOptions.map((b) => ({
                id: b.id,
                label: `${b.name} (${b.code})`,
              }))}
              back={path}
            />
          )}
        </div>
      }
      headerEnd={
        <>
          <a
            href="/notifications"
            aria-label={
              unread ? `Notifications, ${unread} unread` : "Notifications"
            }
            className="relative rounded-md p-2 text-foreground hover:bg-background"
          >
            <BellIcon aria-hidden="true" className="size-5" />
            {unread > 0 && (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white"
              >
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </a>
          <span className="hidden text-sm text-muted md:inline">
            {user.name}
          </span>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </>
      }
    >
      {children}
    </AppShell>
  );
}
