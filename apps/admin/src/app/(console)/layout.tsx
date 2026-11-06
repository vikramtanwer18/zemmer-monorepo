import type { PlatformPermissionKey } from "@gym/core/platform";
import { AppShell, Badge, Button, type NavItem } from "@gym/ui";
import { headers } from "next/headers";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import { signOutAction } from "../(auth)/actions";

const NAV: (NavItem & { permission: PlatformPermissionKey })[] = [
  {
    href: "/",
    label: "Overview",
    icon: "dashboard",
    permission: "platform.tenants.view",
  },
  {
    href: "/tenants",
    label: "Tenants",
    icon: "branches",
    permission: "platform.tenants.view",
  },
  {
    href: "/plans",
    label: "Plans & features",
    icon: "plans",
    permission: "platform.tenants.view",
  },
  {
    href: "/billing",
    label: "Billing",
    icon: "payments",
    permission: "platform.billing.view",
  },
  {
    href: "/usage",
    label: "Usage",
    icon: "attendance",
    permission: "platform.billing.view",
  },
  {
    href: "/announcements",
    label: "Announcements",
    icon: "bell",
    permission: "platform.announcements.manage",
  },
  {
    href: "/system",
    label: "System health",
    icon: "settings",
    permission: "platform.system.view",
  },
  {
    href: "/support",
    label: "Support sessions",
    icon: "support",
    permission: "platform.support.access",
  },
  {
    href: "/settings",
    label: "Platform settings",
    icon: "platform",
    permission: "platform.tenants.view",
  },
  {
    href: "/ai",
    label: "AI provider",
    icon: "copilot",
    permission: "platform.tenants.view",
  },
  {
    href: "/audit-log",
    label: "Audit log",
    icon: "audit",
    permission: "platform.audit.view",
  },
];

export default async function ConsoleLayout({ children }: LayoutProps<"/">) {
  const path = (await headers()).get("x-pathname") ?? "/";
  const { user, ctx } = await requireAdmin(path);
  const nav = NAV.filter((item) => ctx.permissions.has(item.permission));

  return (
    <AppShell
      brand={`${services().brand} Platform`}
      subtitle="Operator console"
      nav={nav}
      currentPath={path}
      headerStart={
        <Badge tone={user.role === "SUPER_ADMIN" ? "info" : "neutral"}>
          {user.role === "SUPER_ADMIN" ? "Super Admin" : "Support"}
        </Badge>
      }
      headerEnd={
        <>
          <span className="hidden text-sm text-muted md:inline">
            {user.email}
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
