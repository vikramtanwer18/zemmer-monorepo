import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getConversation, listTemplates } from "@gym/core/messaging";
import {
  ActionForm,
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  PageHeader,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { TemplateSender } from "@/components/template-sender";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { assignToMeAction, replyAction } from "../actions";

export const metadata: Metadata = { title: "Conversation" };

const STATUS_TONE = {
  SENT: "neutral",
  DELIVERED: "info",
  READ: "success",
  FAILED: "danger",
  SKIPPED: "warning",
  QUEUED: "neutral",
  SENDING: "neutral",
} as const;

export default async function ConversationPage({
  params,
  searchParams,
}: PageProps<"/inbox/[id]">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/inbox/${id}`);
  if (!hasPermission(ctx, "messaging.send")) return <NoAccess />;
  const sp = await searchParams;
  const { deps } = services();
  const c = await orUpgrade(getConversation(deps, ctx, id));
  if (!c)
    return (
      <UpgradeNotice title="WhatsApp inbox" feature="WhatsApp messaging" />
    );
  const templates = await listTemplates(deps, ctx, { approvedOnly: true });
  const canWrite = isTenantWritable(ctx);
  const name = c.member
    ? [c.member.firstName, c.member.lastName].filter(Boolean).join(" ")
    : c.lead
      ? [c.lead.firstName, c.lead.lastName].filter(Boolean).join(" ")
      : (c.profileName ?? c.phone);
  return (
    <>
      <PageHeader
        title={name}
        description={`${c.phone}${c.member ? ` · member ${c.member.memberCode}` : c.lead ? " · lead" : ""}`}
        actions={
          canWrite ? (
            <form action={assignToMeAction}>
              <input type="hidden" name="conversationId" value={c.id} />
              {c.assigneeUserId === ctx.userId && (
                <input type="hidden" name="unassign" value="1" />
              )}
              <Button type="submit" variant="outline" size="sm">
                {c.assigneeUserId === ctx.userId
                  ? "Unassign me"
                  : "Assign to me"}
              </Button>
            </form>
          ) : null
        }
      />
      <Flash params={sp} />
      {c.suppressed && (
        <Alert tone="warning">
          This number opted out (
          {c.suppressed.reason.toLowerCase().replace("_", " ")}). Only their own
          opt-in (reply START) or recorded consent lifts it.
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <Card className="flex flex-col gap-3">
          <CardTitle>Messages</CardTitle>
          <ol className="flex flex-col gap-2" data-testid="timeline">
            {c.timeline.map((m) => (
              <li
                key={m.id}
                className={
                  m.direction === "IN"
                    ? "max-w-[85%] self-start rounded-lg bg-background p-3 text-sm"
                    : "max-w-[85%] self-end rounded-lg bg-primary/10 p-3 text-sm"
                }
              >
                {m.direction === "OUT" && m.template && (
                  <p className="mb-1 font-mono text-xs text-muted">
                    {m.template}
                  </p>
                )}
                <p className="whitespace-pre-wrap">
                  {m.text ?? (m.direction === "IN" ? `[${m.type}]` : "")}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted">
                  {when(m.at, ctx.timezone)}
                  {m.direction === "OUT" && (
                    <Badge
                      tone={
                        STATUS_TONE[m.status as keyof typeof STATUS_TONE] ??
                        "neutral"
                      }
                    >
                      {m.status.toLowerCase()}
                    </Badge>
                  )}
                  {m.direction === "IN" && m.keyword && (
                    <Badge tone="warning">
                      {m.keyword.split(":")[0]?.replace("_", " ").toLowerCase()}
                    </Badge>
                  )}
                  {m.direction === "OUT" && m.note && <span>{m.note}</span>}
                </p>
              </li>
            ))}
          </ol>
          {canWrite &&
            (c.windowOpen ? (
              <ActionForm
                action={replyAction}
                resetOnSuccess
                className="flex flex-col gap-2"
              >
                <input type="hidden" name="conversationId" value={c.id} />
                <TextareaField
                  label="Reply"
                  name="body"
                  rows={3}
                  required
                  hint={`Free text allowed until ${when(c.windowClosesAt, ctx.timezone)}.`}
                />
                <div>
                  <SubmitButton>Send</SubmitButton>
                </div>
              </ActionForm>
            ) : (
              <p className="text-sm text-muted">
                More than 24 hours since their last message: WhatsApp only
                allows a template now.
              </p>
            ))}
        </Card>
        {canWrite && (
          <Card className="flex flex-col gap-3">
            <CardTitle>Send a template</CardTitle>
            <TemplateSender
              templates={templates}
              chosenId={typeof sp.template === "string" ? sp.template : null}
              back={`/inbox/${c.id}`}
              subject={
                c.member
                  ? { memberId: c.member.id }
                  : c.lead
                    ? { leadId: c.lead.id }
                    : { phone: c.phone }
              }
            />
          </Card>
        )}
      </div>
    </>
  );
}
