import {
  Badge,
  ConfirmDialog,
  DataTable,
  FormField,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Flash } from "@/components/flash";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  deactivateAccountAction,
  forgetTrustedDevicesAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
} from "../actions";

export const metadata: Metadata = { title: "My account" };

function describeAgent(ua: string | null | undefined) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

export default async function AccountPage({
  searchParams,
}: PageProps<"/account">) {
  const { user, session, ctx } = await requireReady("/account");
  const { auth, db } = services();
  const [sessions, trustedCount] = await Promise.all([
    auth.api.listSessions({ headers: new Headers(await headers()) }),
    db.trustedDevice.count({
      where: { userId: user.id, expiresAt: { gt: new Date() } },
    }),
  ]);
  const tz = ctx.timezone;

  return (
    <>
      <PageHeader
        title="My account"
        description={`${user.name} · ${user.email}`}
      />
      <Flash params={await searchParams} />

      <section aria-labelledby="sessions-heading" className="mb-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="sessions-heading" className="text-lg font-semibold">
            Where you&apos;re signed in
          </h2>
          {sessions.length > 1 && (
            <ConfirmDialog
              trigger="Sign out everywhere else"
              title="Sign out of every other device?"
              confirmLabel="Sign out others"
              formAction={revokeOtherSessionsAction}
            />
          )}
        </div>
        <DataTable
          caption="Active sessions"
          rows={sessions}
          rowKey={(s) => s.id}
          columns={[
            {
              key: "device",
              header: "Device",
              cell: (s) => (
                <span className="flex items-center gap-2">
                  {describeAgent(s.userAgent)}
                  {s.id === session.id && (
                    <Badge tone="info">This device</Badge>
                  )}
                </span>
              ),
            },
            {
              key: "ip",
              header: "IP address",
              hideOnMobile: true,
              cell: (s) => s.ipAddress ?? "—",
            },
            {
              key: "since",
              header: "Signed in",
              hideOnMobile: true,
              cell: (s) =>
                new Date(s.createdAt).toLocaleString("en-IN", {
                  timeZone: tz,
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
            },
            {
              key: "actions",
              header: "",
              cell: (s) =>
                s.id === session.id ? null : (
                  <ConfirmDialog
                    trigger="Sign out"
                    title="Sign out this device?"
                    confirmLabel="Sign out"
                    formAction={revokeSessionAction}
                    fields={{ sessionId: s.id }}
                  />
                ),
            },
          ]}
        />
      </section>

      {trustedCount > 0 && (
        <section aria-labelledby="trusted-heading" className="mb-8">
          <h2 id="trusted-heading" className="mb-2 text-lg font-semibold">
            Trusted devices
          </h2>
          <p className="mb-3 text-sm text-muted">
            {trustedCount} device{trustedCount === 1 ? "" : "s"} can skip the
            sign-in code.
          </p>
          <ConfirmDialog
            trigger="Forget trusted devices"
            title="Forget all trusted devices?"
            description="Every device will ask for a code at the next sign-in."
            confirmLabel="Forget them"
            formAction={forgetTrustedDevicesAction}
          />
        </section>
      )}

      <section
        aria-labelledby="danger-heading"
        className="rounded-lg border border-danger/30 p-4"
      >
        <h2
          id="danger-heading"
          className="mb-2 text-lg font-semibold text-danger"
        >
          Deactivate account
        </h2>
        <p className="mb-3 text-sm text-muted">
          Signs you out everywhere and blocks sign-in to every gym. Records you
          created stay with each gym.
        </p>
        <ConfirmDialog
          trigger="Deactivate my account"
          title="Deactivate your account?"
          description="Type DEACTIVATE to confirm. Only a platform administrator can undo this."
          confirmLabel="Deactivate"
          formAction={deactivateAccountAction}
        >
          <FormField
            label="Confirmation"
            name="confirm"
            autoComplete="off"
            required
          />
        </ConfirmDialog>
      </section>
    </>
  );
}
