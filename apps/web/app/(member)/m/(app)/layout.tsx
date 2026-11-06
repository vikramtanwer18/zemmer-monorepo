import { getMyPrivacy } from "@gym/core/members";
import { listMyNotifications } from "@gym/core/notifications";
import { MobileTabBar } from "@gym/ui";
import { Bell as BellIcon } from "lucide-react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";

const TABS = [
  { href: "/m/", label: "Home", icon: "home" as const },
  { href: "/m/card", label: "Card", icon: "card" as const },
  { href: "/m/workouts", label: "Train", icon: "train" as const },
  { href: "/m/classes", label: "Classes", icon: "classes" as const },
  { href: "/m/invoices", label: "Payments", icon: "payments" as const },
  { href: "/m/profile", label: "Profile", icon: "profile" as const },
];

export default async function MemberAppLayout({ children }: LayoutProps<"/m">) {
  const path = (await headers()).get("x-pathname") ?? "/m/";
  const { mctx, gyms } = await requireMember(path);
  // Onboarding: the privacy notice comes first (not while a payment is being confirmed).
  if (!path.startsWith("/m/privacy") && !path.startsWith("/m/pay/return")) {
    const privacy = await getMyPrivacy(services().deps, mctx);
    if (!privacy.accepted)
      redirect(`/m/privacy?${new URLSearchParams({ next: path })}`);
  }
  // Workouts, progress, nutrition, rewards and the feed all sit under "Train".
  const trainPaths = [
    "/m/workouts",
    "/m/progress",
    "/m/nutrition",
    "/m/rewards",
    "/m/feed",
  ];
  const { unread } = await listMyNotifications(
    services().db,
    mctx.tenantId,
    mctx.userId,
    1,
  );
  const tab = trainPaths.some((p) => path.startsWith(p))
    ? "/m/workouts"
    : (TABS.find((t) => t.href !== "/m/" && path.startsWith(t.href))?.href ??
      "/m/");
  return (
    <div className="min-h-dvh bg-background pb-20">
      <header className="sticky top-0 z-20 border-b border-border bg-surface">
        <div className="mx-auto flex max-w-md items-center justify-between gap-2 px-4 py-3">
          <span className="truncate font-semibold text-primary">
            {mctx.tenantName}
          </span>
          <span className="flex items-center gap-3">
            {gyms.length > 1 && (
              <a href="/m/gyms" className="text-xs text-primary underline">
                Switch gym
              </a>
            )}
            <a
              href="/m/notifications"
              className="relative text-sm text-primary"
              aria-label={
                unread ? `Notifications, ${unread} unread` : "Notifications"
              }
            >
              <BellIcon aria-hidden="true" className="size-5" />
              {unread > 0 && (
                <span className="absolute -right-2 -top-2 rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </a>
          </span>
        </div>
      </header>
      <main className="mx-auto flex max-w-md flex-col gap-4 p-4">
        {children}
      </main>
      <MobileTabBar items={TABS} currentPath={tab} />
    </div>
  );
}
