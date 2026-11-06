import { hasPermission } from "@gym/core/authz";
import { TOKEN_PERMISSIONS, WEBHOOK_PATH } from "@gym/core/messaging";
import { Card, CardTitle, LinkButton, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";

export const metadata: Metadata = { title: "WhatsApp setup guide" };

function Shot({ label }: { label: string }) {
  // Screenshot placeholders: replaced with real captures once a live WABA is set up (status doc).
  return (
    <div
      className="flex h-36 items-center justify-center rounded-md border border-dashed border-border bg-background text-xs text-muted"
      role="img"
      aria-label={`Screenshot: ${label}`}
    >
      Screenshot: {label}
    </div>
  );
}

export default async function WhatsAppGuidePage() {
  const { ctx } = await requireReady("/settings/whatsapp/guide");
  if (!hasPermission(ctx, "settings.view")) return <NoAccess />;
  const { appUrl } = services();
  const steps: { title: string; body: React.ReactNode; shot: string }[] = [
    {
      title: "1. A Meta Business account for your gym",
      body: (
        <>
          Go to <span className="font-mono">business.facebook.com</span> and
          create (or open) your gym&apos;s business. Complete business
          verification if Meta asks; it raises your sending limits.
        </>
      ),
      shot: "Meta Business Suite → Business settings",
    },
    {
      title: "2. A WhatsApp Business Account and phone number",
      body: (
        <>
          In <span className="font-mono">WhatsApp Manager</span>, add a phone
          number that isn&apos;t used in the WhatsApp app. Verify it by SMS or
          call and set the display name (Meta reviews it). Add a payment method:
          Meta bills your account per conversation.
        </>
      ),
      shot: "WhatsApp Manager → Phone numbers",
    },
    {
      title: "3. A permanent access token",
      body: (
        <>
          Business settings → Users → <b>System users</b> → add one (Admin) →
          Assign assets: your WhatsApp account with full control → Generate
          token with{" "}
          {TOKEN_PERMISSIONS.map((p) => (
            <code key={p} className="mx-1 text-xs">
              {p}
            </code>
          ))}
          and expiry “Never”. Copy it once; it isn&apos;t shown again.
        </>
      ),
      shot: "System users → Generate new token",
    },
    {
      title: "4. The two IDs",
      body: (
        <>
          WhatsApp Manager → <b>API setup</b> (or Phone numbers → the number)
          shows the <b>Phone number ID</b> and the{" "}
          <b>WhatsApp Business Account ID</b>. They are long numbers, not your
          phone number.
        </>
      ),
      shot: "API setup → Phone number ID and WABA ID",
    },
    {
      title: "5. Connect here",
      body: (
        <>
          Paste the IDs and token in Settings → WhatsApp → Manual Connect. We
          check them with WhatsApp right away, subscribe your account to our
          webhook and sync your templates. The token is stored encrypted and
          never shown again.
        </>
      ),
      shot: "Settings → WhatsApp → Manual Connect",
    },
    {
      title: "6. Templates",
      body: (
        <>
          Messages outside a 24-hour reply window must use a template approved
          by Meta. Create them in WhatsApp Manager → Message templates:{" "}
          <b>Utility</b> for reminders and receipts, <b>Marketing</b> for offers
          (these only go to members who agreed to promotional messages). Then
          press “Sync templates”.
        </>
      ),
      shot: "Message templates → Create template",
    },
  ];
  return (
    <>
      <PageHeader
        title="Connect your WhatsApp number"
        description="About 20 minutes, done once. You need admin access to your gym's Meta Business account."
      />
      <div className="flex max-w-3xl flex-col gap-4">
        {steps.map((s) => (
          <Card key={s.title} className="flex flex-col gap-3">
            <CardTitle>{s.title}</CardTitle>
            <p className="text-sm [overflow-wrap:anywhere]">{s.body}</p>
            <Shot label={s.shot} />
          </Card>
        ))}
        <Card className="flex flex-col gap-2 text-sm [overflow-wrap:anywhere]">
          <CardTitle>For the platform operator (once, not per gym)</CardTitle>
          <p>
            The Meta app&apos;s webhook points at{" "}
            <code className="break-all text-xs">
              {appUrl}
              {WEBHOOK_PATH}
            </code>{" "}
            with the verify token from{" "}
            <code className="text-xs">META_WEBHOOK_VERIFY_TOKEN</code>,
            subscribed to <code className="text-xs">messages</code> and{" "}
            <code className="text-xs">message_template_status_update</code>.
            Signatures are checked with{" "}
            <code className="text-xs">META_APP_SECRET</code>.
          </p>
        </Card>
        <div>
          <LinkButton href="/settings/whatsapp">
            Back to WhatsApp settings
          </LinkButton>
        </div>
      </div>
    </>
  );
}
