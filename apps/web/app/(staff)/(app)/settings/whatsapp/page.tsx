import { hasPermission, isTenantWritable } from "@gym/core/authz";
import {
  embeddedSignupAvailability,
  getMessagingSettings,
  getWhatsAppAccount,
  listSuppressions,
  listTemplates,
  TOKEN_PERMISSIONS,
  WEBHOOK_PATH,
} from "@gym/core/messaging";
import {
  ActionForm,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  LinkButton,
  PageHeader,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { SettingsTabs } from "../settings-tabs";
import {
  addSuppressionAction,
  connectAction,
  disconnectAction,
  liftSuppressionAction,
  mapNotificationAction,
  messagingSettingsAction,
  syncAction,
  verifyAction,
} from "./actions";
import { EmbeddedSignupButton } from "./embedded-signup";

export const metadata: Metadata = { title: "WhatsApp" };

const STATUS_TONE = {
  APPROVED: "success",
  PENDING: "warning",
  REJECTED: "danger",
  PAUSED: "warning",
  DISABLED: "danger",
} as const;

export default async function WhatsAppSettingsPage({
  searchParams,
}: PageProps<"/settings/whatsapp">) {
  const { ctx } = await requireReady("/settings/whatsapp");
  if (!hasPermission(ctx, "settings.view")) return <NoAccess />;
  const sp = await searchParams;
  const { deps, appUrl, fakeWhatsApp, meta } = services();
  const account = await getWhatsAppAccount(deps, ctx);
  const canEdit =
    isTenantWritable(ctx) && hasPermission(ctx, "messaging.configure");
  const canSee = hasPermission(ctx, "messaging.send");
  const [templates, settings, suppressions, embedded] = [
    account && canSee ? await orUpgrade(listTemplates(deps, ctx)) : [],
    await getMessagingSettings(deps, ctx),
    canSee ? await listSuppressions(deps, ctx) : [],
    await embeddedSignupAvailability(deps, meta),
  ];
  if (templates === null)
    return <UpgradeNotice title="WhatsApp" feature="WhatsApp messaging" />;
  const mapKey = typeof sp.map === "string" ? sp.map : null;
  const mapTemplate =
    typeof sp.template === "string"
      ? settings.utilityTemplates.find((t) => t.id === sp.template)
      : null;

  return (
    <>
      <PageHeader title="Settings" />
      <SettingsTabs current="/settings/whatsapp" />
      <Flash params={sp} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-4" data-testid="whatsapp-account">
          <CardTitle>Your WhatsApp Business number</CardTitle>
          {account ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  tone={account.status === "ACTIVE" ? "success" : "danger"}
                >
                  {account.status === "ACTIVE"
                    ? "Connected"
                    : "Needs attention"}
                </Badge>
                {account.connectionMethod === "FAKE" && (
                  <Badge>Test provider (development)</Badge>
                )}
                {account.connectionMethod === "EMBEDDED_SIGNUP" && (
                  <Badge tone="info">Embedded Signup</Badge>
                )}
                {account.qualityRating && (
                  <Badge
                    tone={
                      account.qualityRating === "GREEN"
                        ? "success"
                        : account.qualityRating === "RED"
                          ? "danger"
                          : "warning"
                    }
                  >
                    Quality {account.qualityRating.toLowerCase()}
                  </Badge>
                )}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted">Number</dt>
                <dd>
                  {account.displayPhone ?? "—"}{" "}
                  {account.verifiedName ? `(${account.verifiedName})` : ""}
                </dd>
                <dt className="text-muted">Messaging limit</dt>
                <dd>{account.messagingLimit ?? "—"}</dd>
                <dt className="text-muted">WABA ID</dt>
                <dd className="font-mono">{account.wabaId}</dd>
                <dt className="text-muted">Phone number ID</dt>
                <dd className="font-mono">{account.phoneNumberId}</dd>
                <dt className="text-muted">Token</dt>
                <dd className="font-mono">••••{account.tokenLast4}</dd>
                <dt className="text-muted">Templates</dt>
                <dd>
                  {account.approvedTemplates} approved of {account.templates} ·
                  synced {when(account.lastSyncedAt, ctx.timezone)}
                </dd>
              </dl>
              {account.lastError && (
                <p className="text-sm text-danger">{account.lastError}</p>
              )}
              <div className="rounded-md border border-border bg-background p-3 text-sm">
                <p className="font-medium">
                  Webhook (set once in the Meta app, for every gym)
                </p>
                <p
                  className="mt-1 break-all font-mono text-xs"
                  data-testid="webhook-url"
                >
                  {appUrl}
                  {WEBHOOK_PATH}
                </p>
                <p className="mt-2 text-xs text-muted">
                  Fields: messages, message_template_status_update.{" "}
                  {account.webhookSubscribed
                    ? "This WABA is subscribed to our app."
                    : "Not subscribed yet: use Check connection."}
                </p>
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <form action={verifyAction}>
                    <Button type="submit" variant="outline" size="sm">
                      Check connection
                    </Button>
                  </form>
                  <form action={syncAction}>
                    <Button type="submit" variant="outline" size="sm">
                      Sync templates
                    </Button>
                  </form>
                  <LinkButton
                    href={account.templateManagerUrl}
                    variant="ghost"
                    size="sm"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open WhatsApp Manager
                  </LinkButton>
                  <ConfirmDialog
                    trigger="Disconnect"
                    title="Disconnect WhatsApp?"
                    description="Nothing more is sent on WhatsApp (queued messages are skipped). Campaigns and automations stop sending."
                    confirmLabel="Disconnect"
                    formAction={disconnectAction}
                  >
                    <label className="flex flex-col gap-1.5 text-sm font-medium">
                      Reason
                      <input
                        name="reason"
                        required
                        minLength={3}
                        className="h-10 rounded-md border border-border bg-surface px-3"
                      />
                    </label>
                  </ConfirmDialog>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">
              Not connected. Each gym uses its own WhatsApp Business Account, so
              messages come from your number and Meta bills your account. Follow
              the{" "}
              <a
                className="text-primary underline"
                href="/settings/whatsapp/guide"
              >
                setup guide
              </a>
              .
            </p>
          )}
          {canEdit && (
            <details
              open={!account}
              className="rounded-md border border-border p-3"
            >
              <summary className="cursor-pointer text-sm font-medium">
                {account ? "Replace the number or token" : "Manual Connect"}
              </summary>
              <ActionForm
                action={connectAction}
                className="mt-3 flex flex-col gap-3"
              >
                {fakeWhatsApp && (
                  <SelectField
                    label="Provider"
                    name="method"
                    defaultValue="MANUAL"
                    options={[
                      { value: "MANUAL", label: "Meta WhatsApp Cloud API" },
                      {
                        value: "FAKE",
                        label:
                          "Test provider (development only, sends nothing)",
                      },
                    ]}
                  />
                )}
                <FormField
                  label="WhatsApp Business Account ID"
                  name="wabaId"
                  inputMode="numeric"
                  autoComplete="off"
                  required
                />
                <FormField
                  label="Phone number ID"
                  name="phoneNumberId"
                  inputMode="numeric"
                  autoComplete="off"
                  required
                  hint="In Meta: WhatsApp → API setup. Not the phone number itself."
                />
                <FormField
                  label="System-user access token"
                  name="accessToken"
                  type="password"
                  autoComplete="off"
                  required
                  hint={`Permanent token with ${TOKEN_PERMISSIONS.join(" and ")}.`}
                />
                <div>
                  <SubmitButton>Check and connect</SubmitButton>
                </div>
              </ActionForm>
            </details>
          )}
        </Card>

        <Card className="flex flex-col gap-3">
          <CardTitle>Embedded Signup</CardTitle>
          {embedded.available && embedded.appId && embedded.configId ? (
            canEdit ? (
              <EmbeddedSignupButton
                appId={embedded.appId}
                configId={embedded.configId}
              />
            ) : (
              <p className="text-sm text-muted">
                An owner or admin can connect with Facebook.
              </p>
            )
          ) : (
            <>
              <Badge tone="info" className="self-start">
                Coming soon
              </Badge>
              <p className="text-sm text-muted">
                Connecting in a few clicks with your Facebook login will be
                available once our Meta Tech Provider approval is complete.
                Until then, use Manual Connect: it works the same afterwards.
              </p>
            </>
          )}
        </Card>
      </div>

      {account && canSee && (
        <section className="mt-8" aria-labelledby="templates">
          <h2 id="templates" className="mb-3 text-base font-semibold">
            Templates
          </h2>
          <p className="mb-3 text-sm text-muted">
            Created and approved in WhatsApp Manager; synced here on connect,
            nightly and with “Sync templates”. Outside the 24-hour window only
            approved templates can be sent.
          </p>
          <DataTable
            caption="Templates"
            rows={templates}
            rowKey={(t) => t.id}
            empty={
              <EmptyState
                title="No templates yet"
                description="Create one in WhatsApp Manager, wait for approval, then sync."
              />
            }
            columns={[
              {
                key: "name",
                header: "Name",
                cell: (t) => (
                  <span className="flex flex-col">
                    <span className="font-mono text-xs">{t.name}</span>
                    <span className="text-xs text-muted">{t.language}</span>
                  </span>
                ),
              },
              {
                key: "category",
                header: "Category",
                cell: (t) => (
                  <Badge
                    tone={t.category === "MARKETING" ? "warning" : "neutral"}
                  >
                    {t.category.toLowerCase()}
                  </Badge>
                ),
              },
              {
                key: "status",
                header: "Status",
                cell: (t) => (
                  <Badge
                    tone={
                      STATUS_TONE[t.status as keyof typeof STATUS_TONE] ??
                      "neutral"
                    }
                  >
                    {t.status.toLowerCase()}
                  </Badge>
                ),
              },
              {
                key: "body",
                header: "Text",
                hideOnMobile: true,
                cell: (t) => (
                  <span className="line-clamp-2 text-xs">{t.bodyText}</span>
                ),
              },
            ]}
          />
        </section>
      )}

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <CardTitle>Opt-outs and limits</CardTitle>
          <ActionForm
            action={messagingSettingsAction}
            className="flex flex-col gap-3"
          >
            <fieldset disabled={!canEdit} className="flex flex-col gap-3">
              <TextareaField
                label="Opt-out words"
                name="optOutKeywords"
                rows={3}
                defaultValue={settings.optOutKeywords.join(", ")}
                hint="A message that is exactly one of these opts the person out of all WhatsApp messages at once (any case, punctuation ignored)."
              />
              <FormField
                label="Opt-in words"
                name="optInKeywords"
                defaultValue={settings.optInKeywords.join(", ")}
              />
              <FormField
                label="Promotional messages per person per day (campaigns + automations)"
                name="marketingDailyCap"
                type="number"
                min={0}
                max={10}
                defaultValue={settings.marketingDailyCap}
              />
              {canEdit && (
                <div>
                  <SubmitButton variant="outline">Save</SubmitButton>
                </div>
              )}
            </fieldset>
          </ActionForm>
        </Card>

        <Card className="flex flex-col gap-3">
          <CardTitle>Reminders and receipts on WhatsApp</CardTitle>
          <p className="text-sm text-muted">
            Pick an approved UTILITY template for each message. Email and in-app
            messages continue as before.
          </p>
          <ul className="flex flex-col divide-y divide-border text-sm">
            {settings.notifications.map((n) => {
              const mapped = n.mapping
                ? settings.utilityTemplates.find(
                    (t) => t.id === n.mapping!.templateId,
                  )
                : null;
              return (
                <li key={n.key} className="flex flex-col gap-2 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">{n.key}</span>{" "}
                      <span className="text-muted">
                        {mapped ? `→ ${mapped.name}` : "· not on WhatsApp"}
                      </span>
                    </span>
                    {canEdit && account && (
                      <form method="get" className="flex items-center gap-2">
                        <input type="hidden" name="map" value={n.key} />
                        <select
                          name="template"
                          aria-label={`Template for ${n.key}`}
                          defaultValue={n.mapping?.templateId ?? ""}
                          className="h-9 rounded-md border border-border bg-surface px-2"
                        >
                          <option value="">Choose a template…</option>
                          {settings.utilityTemplates
                            .filter((t) => t.status === "APPROVED")
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                        </select>
                        <Button type="submit" size="sm" variant="outline">
                          Set up
                        </Button>
                      </form>
                    )}
                  </div>
                  {mapKey === n.key && mapTemplate && (
                    <form
                      action={mapNotificationAction}
                      className="flex flex-col gap-2 rounded-md border border-border p-3"
                    >
                      <input type="hidden" name="key" value={n.key} />
                      <input
                        type="hidden"
                        name="templateId"
                        value={mapTemplate.id}
                      />
                      <p className="text-xs text-muted">
                        {mapTemplate.bodyText}
                      </p>
                      {mapTemplate.variables.map((v) => (
                        <label key={v} className="flex items-center gap-2">
                          <code className="w-24 text-xs">{`{{${v}}}`}</code>
                          <select
                            name={`var_${v}`}
                            required
                            defaultValue={
                              n.mapping?.variables[v] ??
                              n.dataKeys[Number(v) - 1] ??
                              n.dataKeys[0]
                            }
                            className="h-9 flex-1 rounded-md border border-border bg-surface px-2"
                          >
                            {n.dataKeys.map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                      <div className="flex gap-2">
                        <Button type="submit" size="sm">
                          Save
                        </Button>
                      </div>
                    </form>
                  )}
                  {canEdit && n.mapping && mapKey !== n.key && (
                    <form action={mapNotificationAction}>
                      <input type="hidden" name="key" value={n.key} />
                      <input type="hidden" name="templateId" value="" />
                      <Button type="submit" size="sm" variant="ghost">
                        Stop sending on WhatsApp
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      {canSee && (
        <section className="mt-8 max-w-3xl" aria-labelledby="optouts">
          <h2 id="optouts" className="mb-3 text-base font-semibold">
            Opted-out numbers
          </h2>
          <DataTable
            caption="Opted-out numbers"
            rows={suppressions}
            rowKey={(s) => s.id}
            empty={
              <EmptyState
                title="Nobody has opted out"
                description="When someone replies STOP, they appear here and get nothing more on WhatsApp."
              />
            }
            columns={[
              {
                key: "address",
                header: "Number",
                cell: (s) => <span className="font-mono">{s.address}</span>,
              },
              {
                key: "reason",
                header: "Why",
                cell: (s) => (
                  <span className="flex flex-col">
                    <span>{s.reason.replace("_", " ").toLowerCase()}</span>
                    <span className="text-xs text-muted">{s.note}</span>
                  </span>
                ),
              },
              {
                key: "at",
                header: "Since",
                hideOnMobile: true,
                cell: (s) => when(s.createdAt, ctx.timezone),
              },
              {
                key: "lift",
                header: "",
                cell: (s) =>
                  canEdit ? (
                    <ConfirmDialog
                      trigger="Lift"
                      title={`Message ${s.address} again?`}
                      description="Only with the person's new consent. Record how they agreed."
                      confirmLabel="Lift opt-out"
                      formAction={liftSuppressionAction}
                      fields={{ phone: s.address }}
                    >
                      <label className="flex flex-col gap-1.5 text-sm font-medium">
                        How they agreed
                        <input
                          name="evidence"
                          required
                          minLength={10}
                          className="h-10 rounded-md border border-border bg-surface px-3"
                        />
                      </label>
                    </ConfirmDialog>
                  ) : null,
              },
            ]}
          />
          {hasPermission(ctx, "messaging.send") && isTenantWritable(ctx) && (
            <ActionForm
              action={addSuppressionAction}
              resetOnSuccess
              className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <FormField
                label="Opt out a number"
                name="phone"
                required
                placeholder="98765 43210"
              />
              <FormField
                label="Why"
                name="note"
                required
                placeholder="Asked at the front desk"
              />
              <SubmitButton variant="outline">Opt out</SubmitButton>
            </ActionForm>
          )}
        </section>
      )}
    </>
  );
}
