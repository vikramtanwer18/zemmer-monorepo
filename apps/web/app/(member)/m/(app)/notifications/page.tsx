import {
  listMyNotifications,
  markNotificationsRead,
} from "@gym/core/notifications";
import { Card, EmptyState } from "@gym/ui";
import type { Metadata } from "next";
import { when } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";

export const metadata: Metadata = { title: "Notifications" };

/** The member's in-app notifications (plan assigned, trainer feedback, gym news, milestones…). */
export default async function MemberNotificationsPage() {
  const { mctx } = await requireMember("/m/notifications");
  const { db } = services();
  const { rows } = await listMyNotifications(
    db,
    mctx.tenantId,
    mctx.userId,
    50,
  );
  // Opening the list marks everything read.
  await markNotificationsRead(db, mctx.tenantId, mctx.userId, "all");
  return (
    <>
      <h1 className="text-2xl font-semibold">Notifications</h1>
      {rows.length === 0 && <EmptyState title="Nothing yet" />}
      <ul className="flex flex-col gap-2" data-testid="member-notifications">
        {rows.map((n) => {
          // Only links inside the member app.
          const href = n.link && /^\/m\/[\w\-/]*$/.test(n.link) ? n.link : null;
          const body = (
            <Card className={n.readAt ? "" : "border-primary"}>
              <p className="font-medium">{n.title}</p>
              <p className="line-clamp-3 whitespace-pre-wrap text-sm">
                {n.body}
              </p>
              <p className="mt-1 text-xs text-muted">
                {when(n.createdAt, mctx.timezone)}
              </p>
            </Card>
          );
          return <li key={n.id}>{href ? <a href={href}>{body}</a> : body}</li>;
        })}
      </ul>
    </>
  );
}
