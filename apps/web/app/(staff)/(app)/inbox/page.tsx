import { hasPermission } from "@gym/core/authz";
import { listConversations } from "@gym/core/messaging";
import {
  Badge,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
  Tabs,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";

export const metadata: Metadata = { title: "WhatsApp inbox" };

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const { ctx } = await requireReady("/inbox");
  if (!hasPermission(ctx, "messaging.send")) return <NoAccess />;
  const sp = await searchParams;
  const view = sp.view === "mine" || sp.view === "unread" ? sp.view : "all";
  const data = await orUpgrade(
    listConversations(services().deps, ctx, {
      mine: view === "mine",
      unread: view === "unread",
    }),
  );
  if (!data)
    return (
      <UpgradeNotice title="WhatsApp inbox" feature="WhatsApp messaging" />
    );
  if (!data.account)
    return (
      <>
        <PageHeader title="WhatsApp inbox" />
        <EmptyState
          title="WhatsApp isn't connected"
          description="Connect your gym's WhatsApp Business number to see replies here."
          action={
            <LinkButton href="/settings/whatsapp">Connect WhatsApp</LinkButton>
          }
        />
      </>
    );
  return (
    <>
      <PageHeader
        title="WhatsApp inbox"
        description={`Replies to ${data.account.displayPhone ?? "your number"}. You can answer freely within 24 hours of their last message; after that, only with a template.`}
      />
      <Tabs
        label="Inbox views"
        current={`/inbox${view === "all" ? "" : `?view=${view}`}`}
        items={[
          { href: "/inbox", label: "All" },
          { href: "/inbox?view=unread", label: "Unread" },
          { href: "/inbox?view=mine", label: "Assigned to me" },
        ]}
      />
      <Flash params={sp} />
      <DataTable
        caption="Conversations"
        rows={data.rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="No messages"
            description="When members or leads message your WhatsApp number, they show up here."
          />
        }
        columns={[
          {
            key: "who",
            header: "Contact",
            cell: (r) => (
              <a href={`/inbox/${r.id}`} className="flex flex-col">
                <span className="font-medium text-primary underline">
                  {r.name}
                </span>
                <span className="text-xs text-muted">
                  {r.member
                    ? `Member ${r.member.memberCode}`
                    : r.lead
                      ? "Lead"
                      : "Not matched"}{" "}
                  · {r.phone}
                </span>
              </a>
            ),
          },
          {
            key: "last",
            header: "Last message",
            hideOnMobile: true,
            cell: (r) => (
              <span className="line-clamp-1 text-sm">{r.lastText ?? "—"}</span>
            ),
          },
          {
            key: "when",
            header: "When",
            cell: (r) => when(r.lastMessageAt, ctx.timezone),
          },
          {
            key: "state",
            header: "",
            cell: (r) => (
              <span className="flex gap-1">
                {r.unread > 0 && <Badge tone="info">{r.unread} new</Badge>}
                <Badge tone={r.windowOpen ? "success" : "neutral"}>
                  {r.windowOpen ? "Can reply" : "Template only"}
                </Badge>
              </span>
            ),
          },
        ]}
      />
    </>
  );
}
