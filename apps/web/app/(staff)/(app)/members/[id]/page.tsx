import { hasPermission, isTenantWritable } from "@gym/core/authz";
import {
  listInvoices,
  listPayments,
  memberFinancialSummary,
} from "@gym/core/billing";
import { isAppError } from "@gym/core/errors";
import { getMemberProfile, memberName } from "@gym/core/members";
import { inTenant } from "@gym/core/tenancy";
import {
  ActionForm,
  Badge,
  Breadcrumbs,
  Card,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  LinkButton,
  PageHeader,
  SelectField,
  StatCard,
  SubmitButton,
  Tabs,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Flash } from "@/components/flash";
import { InvoiceBadge } from "@/components/invoice-badge";
import { NoAccess } from "@/components/no-access";
import { day, inr, str, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  addNoteAction,
  applyCreditAction,
  cancelAction,
  consentAction,
  extendAction,
  freezeAction,
  inviteToAppAction,
  joinDecisionAction,
  refundAction,
  renewAction,
  unfreezeAction,
  voidPaymentAction,
} from "../actions";
import { DocumentUploader } from "./document-uploader";
import { AttendanceTab, TrainingTab } from "./m3-sections";
import { PhotoUploader } from "./photo-uploader";

export const metadata: Metadata = { title: "Member" };

const TABS = [
  "overview",
  "memberships",
  "billing",
  "attendance",
  "training",
  "notes",
  "documents",
  "consents",
] as const;
const TAB_LABEL: Record<(typeof TABS)[number], string> = {
  overview: "Overview",
  memberships: "Memberships",
  billing: "Invoices & payments",
  attendance: "Check-ins",
  training: "Training",
  notes: "Notes",
  documents: "Documents",
  consents: "Consents",
};
const STATE_TONE = {
  ACTIVE: "success",
  PAUSED: "info",
  PENDING_PAYMENT: "warning",
  EXPIRED: "neutral",
  CANCELLED: "danger",
} as const;
const STATE_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  PAUSED: "Frozen",
  PENDING_PAYMENT: "Awaiting payment",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};
const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "CARD_TERMINAL", label: "Card machine" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "OTHER", label: "Other" },
];

export default async function MemberPage({
  params,
  searchParams,
}: PageProps<"/members/[id]">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/members/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const tab = (TABS as readonly string[]).includes(str(sp.tab) ?? "")
    ? (str(sp.tab) as (typeof TABS)[number])
    : "overview";
  const { deps } = services();
  const profile = await getMemberProfile(deps, ctx, id).catch((err) => {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    if (isAppError(err) && err.code === "FORBIDDEN") return null;
    throw err;
  });
  if (!profile) return <NoAccess />;
  const { member, memberships } = profile;
  const branch = member.homeBranchId;
  const writable = isTenantWritable(ctx);
  const can = (key: Parameters<typeof hasPermission>[1]) =>
    writable && hasPermission(ctx, key, { branchId: branch });
  const canSeeBilling = hasPermission(ctx, "billing.view", {
    branchId: branch,
  });
  const summary = canSeeBilling
    ? await inTenant(deps, ctx, (tx) => memberFinancialSummary(tx, id))
    : null;
  const href = (t: string) => `/members/${id}?tab=${t}`;

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Members", href: "/members" },
          { label: memberName(member) },
        ]}
      />
      <PageHeader
        title={memberName(member)}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {member.memberCode} · {profile.homeBranch.name}
            {member.status !== "ACTIVE" && (
              <Badge tone="warning">
                {member.status === "ARCHIVED"
                  ? "Archived"
                  : "Awaiting approval"}
              </Badge>
            )}
            {member.userId && <Badge tone="info">App account</Badge>}
          </span>
        }
        actions={
          <>
            {can("members.edit") && (
              <LinkButton href={`/members/${id}/edit`} variant="outline">
                Edit
              </LinkButton>
            )}
            {can("billing.collect") && member.status === "ACTIVE" && (
              <LinkButton href={`/members/${id}/pay`} variant="outline">
                Record payment
              </LinkButton>
            )}
            {can("memberships.sell") && member.status === "ACTIVE" && (
              <LinkButton href={`/members/${id}/sell`}>
                Sell membership
              </LinkButton>
            )}
          </>
        }
      />
      <Flash params={sp} />
      {member.status === "PENDING_APPROVAL" && can("members.edit") && (
        <Card className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            This person asked to join through your join link.
          </p>
          <div className="flex gap-2">
            <ConfirmDialog
              trigger="Decline"
              title="Decline this request?"
              confirmLabel="Decline"
              formAction={joinDecisionAction}
              fields={{ memberId: id, approve: "false" }}
            />
            <ConfirmDialog
              trigger="Approve"
              triggerVariant="primary"
              title={`Approve ${memberName(member)}?`}
              description="They get access to the member app for your gym."
              confirmLabel="Approve"
              confirmVariant="primary"
              formAction={joinDecisionAction}
              fields={{ memberId: id, approve: "true" }}
            />
          </div>
        </Card>
      )}
      <Tabs
        label="Member sections"
        current={href(tab)}
        items={TABS.map((t) => ({ href: href(t), label: TAB_LABEL[t] }))}
      />

      {tab === "overview" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            {can("members.edit") ? (
              <div className="mb-4">
                <PhotoUploader
                  memberId={id}
                  hasPhoto={member.photoFileId !== null}
                  name={memberName(member)}
                />
              </div>
            ) : null}
            <CardTitle>Details</CardTitle>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted">Mobile</dt>
              <dd>{member.phone ?? "—"}</dd>
              <dt className="text-muted">Email</dt>
              <dd>{member.email ?? "—"}</dd>
              <dt className="text-muted">Date of birth</dt>
              <dd>{day(member.dateOfBirth)}</dd>
              <dt className="text-muted">Address</dt>
              <dd>
                {[member.addressLine1, member.city, member.postalCode]
                  .filter(Boolean)
                  .join(", ") || "—"}
              </dd>
              <dt className="text-muted">Emergency contact</dt>
              <dd>
                {[member.emergencyName, member.emergencyPhone]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </dd>
              <dt className="text-muted">Joined</dt>
              <dd>{when(member.joinedAt, ctx.timezone)}</dd>
              <dt className="text-muted">Source</dt>
              <dd>{member.source.replace("_", " ").toLowerCase()}</dd>
            </dl>
          </Card>
          <div className="flex flex-col gap-4">
            {summary && (
              <>
                <StatCard
                  label="Outstanding"
                  value={inr(summary.outstandingMinor)}
                  tone={summary.outstandingMinor > 0 ? "warning" : "default"}
                />
                <StatCard
                  label="Credit"
                  value={inr(summary.creditMinor)}
                  hint={`Invoiced ${inr(summary.invoicedMinor)} · paid ${inr(summary.paidMinor)}`}
                />
              </>
            )}
            {can("members.edit") &&
              !member.userId &&
              member.status === "ACTIVE" && (
                <Card>
                  <CardTitle>Member app</CardTitle>
                  <p className="mt-1 text-sm text-muted">
                    {member.email
                      ? `Email ${member.email} a link to set a password.`
                      : "Add an email to invite them to the app."}
                  </p>
                  {member.email && (
                    <div className="mt-3">
                      <ConfirmDialog
                        trigger="Send app invite"
                        triggerVariant="outline"
                        title="Send the member app invite?"
                        confirmLabel="Send"
                        confirmVariant="primary"
                        formAction={inviteToAppAction}
                        fields={{ memberId: id }}
                      />
                    </div>
                  )}
                </Card>
              )}
          </div>
        </div>
      )}

      {tab === "memberships" && (
        <DataTable
          caption="Memberships"
          rows={memberships}
          rowKey={(m) => m.id}
          empty={
            <EmptyState
              title="No memberships yet"
              action={
                can("memberships.sell") && member.status === "ACTIVE" ? (
                  <LinkButton href={`/members/${id}/sell`}>
                    Sell a membership
                  </LinkButton>
                ) : undefined
              }
            />
          }
          columns={[
            {
              key: "plan",
              header: "Plan",
              cell: (m) => <span className="font-medium">{m.plan.name}</span>,
            },
            {
              key: "state",
              header: "Status",
              cell: (m) => (
                <Badge tone={STATE_TONE[m.status]}>
                  {STATE_LABEL[m.status]}
                </Badge>
              ),
            },
            {
              key: "dates",
              header: "Dates",
              cell: (m) => `${day(m.startDate)} – ${day(m.endDate)}`,
            },
            {
              key: "freeze",
              header: "Frozen",
              hideOnMobile: true,
              cell: (m) => (m.frozenDays ? `${m.frozenDays} day(s)` : "—"),
            },
            {
              key: "actions",
              header: "",
              cell: (m) => (
                <div className="flex flex-wrap gap-2">
                  {can("memberships.sell") &&
                    ["ACTIVE", "PAUSED", "EXPIRED"].includes(m.status) && (
                      <ConfirmDialog
                        trigger="Renew"
                        title={`Renew ${m.plan.name}?`}
                        description="A new membership starts the day after this one ends (or today if it has ended), with a new invoice."
                        confirmLabel="Renew"
                        confirmVariant="primary"
                        formAction={renewAction}
                        fields={{ memberId: id, membershipId: m.id }}
                      />
                    )}
                  {can("memberships.manage") &&
                    m.status === "ACTIVE" &&
                    m.freezes.length === 0 &&
                    m.plan.freezeMaxTimes > 0 && (
                      <ConfirmDialog
                        trigger="Freeze"
                        title="Freeze this membership"
                        confirmLabel="Freeze"
                        confirmVariant="primary"
                        formAction={freezeAction}
                        fields={{ memberId: id, membershipId: m.id }}
                      >
                        <p className="text-sm text-muted">
                          Plan allows {m.plan.freezeMaxTimes} freeze(s),{" "}
                          {m.plan.freezeMaxDays} days in total. Used:{" "}
                          {m.freezeCount} / {m.frozenDays} days. The end date
                          moves out by the frozen days.
                        </p>
                        <FormField label="Start" name="startDate" type="date" />
                        <FormField
                          label="Days"
                          name="days"
                          type="number"
                          min={1}
                          required
                        />
                        <FormField label="Reason" name="reason" required />
                      </ConfirmDialog>
                    )}
                  {can("memberships.manage") && m.freezes.length > 0 && (
                    <ConfirmDialog
                      trigger="End freeze"
                      title="End the freeze now?"
                      description="Unused freeze days come off the end date."
                      confirmLabel="End freeze"
                      confirmVariant="primary"
                      formAction={unfreezeAction}
                      fields={{ memberId: id, membershipId: m.id }}
                    />
                  )}
                  {can("memberships.manage") &&
                    ["ACTIVE", "PAUSED", "PENDING_PAYMENT"].includes(
                      m.status,
                    ) && (
                      <ConfirmDialog
                        trigger="Extend"
                        title="Extend (no charge)"
                        confirmLabel="Extend"
                        confirmVariant="primary"
                        formAction={extendAction}
                        fields={{ memberId: id, membershipId: m.id }}
                      >
                        <FormField
                          label="Days"
                          name="days"
                          type="number"
                          min={1}
                          required
                        />
                        <FormField label="Reason" name="reason" required />
                      </ConfirmDialog>
                    )}
                  {can("memberships.manage") &&
                    ["ACTIVE", "PAUSED", "PENDING_PAYMENT"].includes(
                      m.status,
                    ) && (
                      <ConfirmDialog
                        trigger="Cancel"
                        title={`Cancel ${m.plan.name}?`}
                        confirmLabel="Cancel membership"
                        formAction={cancelAction}
                        fields={{ memberId: id, membershipId: m.id }}
                      >
                        <p className="text-sm text-muted">
                          Refund rule:{" "}
                          {m.plan.refundRule === "NONE"
                            ? "no refunds"
                            : m.plan.refundRule === "PRORATA"
                              ? "pro rata for unused days"
                              : "full refund before it starts"}
                          . Unpaid dues are cancelled with a credit note.
                        </p>
                        <TextareaField label="Reason" name="reason" required />
                        {hasPermission(ctx, "billing.refund", {
                          branchId: branch,
                        }) &&
                          m.plan.refundRule !== "NONE" && (
                            <>
                              <FormField
                                label="Refund (₹)"
                                name="refund"
                                inputMode="decimal"
                                hint="Leave empty for no refund."
                              />
                              <SelectField
                                label="Refund method"
                                name="refundMethod"
                                options={METHODS}
                                placeholder="If refunding"
                              />
                              <FormField
                                label="Refund reference"
                                name="refundReference"
                              />
                            </>
                          )}
                      </ConfirmDialog>
                    )}
                </div>
              ),
            },
          ]}
        />
      )}

      {tab === "billing" &&
        (canSeeBilling ? (
          <BillingTab memberId={id} branch={branch} />
        ) : (
          <NoAccess />
        ))}

      {tab === "attendance" && (
        <AttendanceTab ctx={ctx} memberId={id} branchId={branch} />
      )}

      {tab === "training" && (
        <TrainingTab
          ctx={ctx}
          memberId={id}
          branchId={branch}
          active={member.status === "ACTIVE"}
        />
      )}

      {tab === "notes" && (
        <div className="grid max-w-3xl gap-6">
          {can("members.edit") && (
            <ActionForm
              action={addNoteAction}
              resetOnSuccess
              className="flex flex-col gap-3"
            >
              <input type="hidden" name="memberId" value={id} />
              <TextareaField label="Add a note" name="body" required />
              {profile.canSeePrivateNotes && (
                <SelectField
                  label="Who can see it"
                  name="visibility"
                  options={[
                    {
                      value: "STAFF",
                      label: "All staff who can see this member",
                    },
                    { value: "MANAGEMENT", label: "Managers and admins only" },
                  ]}
                />
              )}
              <div>
                <SubmitButton variant="outline">Add note</SubmitButton>
              </div>
            </ActionForm>
          )}
          {profile.notes.length === 0 ? (
            <EmptyState title="No notes yet" />
          ) : (
            <ul className="flex flex-col gap-3">
              {profile.notes.map((n) => (
                <li
                  key={n.id}
                  className="rounded-md border border-border bg-surface p-3 text-sm"
                >
                  <p className="whitespace-pre-wrap">{n.body}</p>
                  <p className="mt-2 text-xs text-muted">
                    {n.authorName} · {when(n.createdAt, ctx.timezone)}{" "}
                    {n.visibility === "MANAGEMENT" && (
                      <Badge tone="warning">Managers only</Badge>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "documents" && (
        <div className="grid max-w-3xl gap-6">
          {can("members.edit") && <DocumentUploader memberId={id} />}
          <DataTable
            caption="Documents"
            rows={profile.documents}
            rowKey={(d) => d.id}
            empty={
              <EmptyState
                title="No documents"
                description="ID proof, medical clearance, signed waivers."
              />
            }
            columns={[
              {
                key: "title",
                header: "Document",
                cell: (d) =>
                  d.file.scanStatus === "INFECTED" ? (
                    <span>{d.title}</span>
                  ) : (
                    <a
                      className="font-medium text-primary underline"
                      href={`/api/documents/${d.id}`}
                    >
                      {d.title}
                    </a>
                  ),
              },
              {
                key: "file",
                header: "File",
                hideOnMobile: true,
                cell: (d) =>
                  `${d.file.filename} · ${Math.ceil(d.file.size / 1024)} KB`,
              },
              {
                key: "scan",
                header: "Scan",
                cell: (d) => (
                  <Badge
                    tone={
                      d.file.scanStatus === "INFECTED" ? "danger" : "neutral"
                    }
                  >
                    {d.file.scanStatus.toLowerCase()}
                  </Badge>
                ),
              },
              {
                key: "when",
                header: "Added",
                hideOnMobile: true,
                cell: (d) => when(d.createdAt, ctx.timezone),
              },
            ]}
          />
        </div>
      )}

      {tab === "consents" && (
        <div className="grid max-w-3xl gap-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(
              [
                [
                  "EMAIL",
                  "SERVICE",
                  "Service emails",
                  profile.currentConsents.serviceEmail,
                ],
                [
                  "WHATSAPP",
                  "SERVICE",
                  "Service WhatsApp",
                  profile.currentConsents.serviceWhatsapp,
                ],
                [
                  "EMAIL",
                  "MARKETING",
                  "Offers by email",
                  profile.currentConsents.marketingEmail,
                ],
                [
                  "WHATSAPP",
                  "MARKETING",
                  "Offers on WhatsApp",
                  profile.currentConsents.marketingWhatsapp,
                ],
              ] as const
            ).map(([channel, purpose, label, granted]) => (
              <Card
                key={`${channel}-${purpose}`}
                className="flex items-center justify-between gap-3 p-4"
              >
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <Badge tone={granted ? "success" : "neutral"}>
                    {granted ? "Yes" : "No"}
                  </Badge>
                </div>
                {can("members.edit") && (
                  <ConfirmDialog
                    trigger={granted ? "Record opt-out" : "Record opt-in"}
                    title={`${granted ? "Opt out of" : "Opt in to"} ${label.toLowerCase()}?`}
                    description={
                      purpose === "MARKETING" && !granted
                        ? "Only if the member clearly said yes. Write down how."
                        : "Takes effect for every message from now on."
                    }
                    confirmLabel="Record"
                    confirmVariant="primary"
                    formAction={consentAction}
                    fields={{
                      memberId: id,
                      channel,
                      purpose,
                      granted: granted ? "false" : "true",
                    }}
                  >
                    <FormField
                      label="How was this given?"
                      name="evidence"
                      placeholder="e.g. said yes at the front desk"
                    />
                  </ConfirmDialog>
                )}
              </Card>
            ))}
          </div>
          <DataTable
            caption="Consent history"
            rows={profile.consents}
            rowKey={(c) => c.id}
            columns={[
              {
                key: "when",
                header: "When",
                cell: (c) => when(c.capturedAt, ctx.timezone),
              },
              {
                key: "what",
                header: "What",
                cell: (c) =>
                  `${c.purpose.toLowerCase()} · ${c.channel.toLowerCase()}`,
              },
              {
                key: "status",
                header: "Status",
                cell: (c) => (
                  <Badge tone={c.status === "GRANTED" ? "success" : "neutral"}>
                    {c.status.toLowerCase()}
                  </Badge>
                ),
              },
              {
                key: "how",
                header: "How",
                hideOnMobile: true,
                cell: (c) =>
                  `${c.method.replace("_", " ").toLowerCase()}${c.evidence ? `: ${c.evidence}` : ""}`,
              },
            ]}
          />
        </div>
      )}
    </>
  );
}

async function BillingTab({
  memberId,
  branch,
}: {
  memberId: string;
  branch: string;
}) {
  const { ctx } = await requireReady(`/members/${memberId}`);
  const { deps } = services();
  const [invoices, payments, summary] = await Promise.all([
    listInvoices(deps, ctx, { memberId }),
    listPayments(deps, ctx, { memberId }),
    inTenant(deps, ctx, (tx) => memberFinancialSummary(tx, memberId)),
  ]);
  const writable = isTenantWritable(ctx);
  const canVoid =
    writable && hasPermission(ctx, "billing.void", { branchId: branch });
  const canCollect =
    writable && hasPermission(ctx, "billing.collect", { branchId: branch });
  const canRefund =
    writable && hasPermission(ctx, "billing.refund", { branchId: branch });
  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Invoiced" value={inr(summary.invoicedMinor)} />
        <StatCard label="Paid" value={inr(summary.paidMinor)} />
        <StatCard
          label="Outstanding"
          value={inr(summary.outstandingMinor)}
          tone={summary.outstandingMinor > 0 ? "warning" : "default"}
        />
        <StatCard label="Credit" value={inr(summary.creditMinor)} />
      </div>
      {summary.creditMinor > 0 && (canCollect || canRefund) && (
        <div className="flex flex-wrap gap-2">
          {canCollect && summary.outstandingMinor > 0 && (
            <ConfirmDialog
              trigger="Apply credit to dues"
              title="Use the member's credit on open invoices?"
              confirmLabel="Apply"
              confirmVariant="primary"
              formAction={applyCreditAction}
              fields={{ memberId }}
            />
          )}
          {canRefund && (
            <ConfirmDialog
              trigger="Refund credit"
              title="Record a refund paid out of credit"
              confirmLabel="Record refund"
              formAction={refundAction}
              fields={{ memberId }}
            >
              <FormField
                label="Amount (₹)"
                name="amount"
                inputMode="decimal"
                required
              />
              <SelectField
                label="Paid back by"
                name="method"
                options={METHODS}
              />
              <FormField label="Reference" name="reference" />
              <FormField label="Reason" name="reason" required />
            </ConfirmDialog>
          )}
        </div>
      )}
      <section aria-labelledby="inv-h">
        <h2 id="inv-h" className="mb-3 text-lg font-semibold">
          Invoices
        </h2>
        <DataTable
          caption="Invoices"
          rows={invoices.rows}
          rowKey={(i) => i.id}
          empty={<EmptyState title="No invoices" />}
          columns={[
            {
              key: "number",
              header: "Number",
              cell: (i) => (
                <a
                  className="font-medium text-primary underline"
                  href={`/invoices/${i.id}`}
                >
                  {i.number}
                </a>
              ),
            },
            { key: "date", header: "Date", cell: (i) => day(i.issueDate) },
            { key: "total", header: "Total", cell: (i) => inr(i.totalMinor) },
            {
              key: "due",
              header: "Due",
              cell: (i) => inr(i.balance.outstandingMinor),
            },
            {
              key: "status",
              header: "Status",
              hideOnMobile: true,
              cell: (i) => <InvoiceBadge status={i.status} />,
            },
          ]}
        />
      </section>
      <section aria-labelledby="pay-h">
        <h2 id="pay-h" className="mb-3 text-lg font-semibold">
          Payments
        </h2>
        <DataTable
          caption="Payments"
          rows={payments.rows}
          rowKey={(p) => p.id}
          empty={<EmptyState title="No payments" />}
          columns={[
            { key: "receipt", header: "Receipt", cell: (p) => p.receiptNumber },
            {
              key: "when",
              header: "Received",
              cell: (p) => when(p.receivedAt, ctx.timezone),
            },
            {
              key: "amount",
              header: "Amount",
              cell: (p) => inr(p.amountMinor),
            },
            {
              key: "method",
              header: "Method",
              hideOnMobile: true,
              cell: (p) =>
                `${p.method.replace("_", " ").toLowerCase()}${p.reference ? ` · ${p.reference}` : ""}`,
            },
            {
              key: "status",
              header: "Status",
              cell: (p) =>
                p.status === "VOID" ? (
                  <Badge tone="danger">Void</Badge>
                ) : (
                  <Badge tone="success">OK</Badge>
                ),
            },
            {
              key: "void",
              header: "",
              cell: (p) =>
                canVoid && p.status === "SUCCEEDED" ? (
                  <ConfirmDialog
                    trigger="Void"
                    title={`Void receipt ${p.receiptNumber}?`}
                    description="Its allocations are reversed. Memberships it activated stay active; review them."
                    confirmLabel="Void payment"
                    formAction={voidPaymentAction}
                    fields={{
                      paymentId: p.id,
                      back: `/members/${memberId}?tab=billing`,
                    }}
                  >
                    <FormField label="Reason" name="reason" required />
                  </ConfirmDialog>
                ) : null,
            },
          ]}
        />
      </section>
    </div>
  );
}
