import { listMyNotifications } from "@gym/core/notifications";
import { Badge, Button, EmptyState, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { markAllReadAction } from "../actions";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const { ctx } = await requireReady("/notifications");
  const { rows, unread } = await listMyNotifications(
    services().db,
    ctx.tenantId,
    ctx.userId,
    50,
  );
  return (
    <>
      <PageHeader
        title="Notifications"
        description={unread ? `${unread} unread` : "All caught up"}
        actions={
          unread > 0 && (
            <form action={markAllReadAction}>
              <Button type="submit" variant="outline">
                Mark all as read
              </Button>
            </form>
          )
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="No notifications yet" />
      ) : (
        <ul className="flex max-w-3xl flex-col gap-2">
          {rows.map((n) => (
            <li
              key={n.id}
              className="rounded-md border border-border bg-surface p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {n.link ? (
                      <a className="text-primary underline" href={n.link}>
                        {n.title}
                      </a>
                    ) : (
                      n.title
                    )}
                  </p>
                  <p className="text-sm text-muted">{n.body}</p>
                </div>
                {!n.readAt && <Badge tone="info">New</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted">
                {when(n.createdAt, ctx.timezone)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
