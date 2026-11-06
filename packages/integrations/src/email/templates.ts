/** Simple branded transactional emails. Every variable is HTML-escaped. */

export type RenderedEmail = { subject: string; html: string; text: string };

const PRIMARY = "#204289";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(options: {
  brand: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  code?: string;
  footer: string;
}): string {
  const body = options.paragraphs
    .map(
      (p) => `<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(p)}</p>`,
    )
    .join("");
  const code = options.code
    ? `<p style="margin:8px 0 24px;font-size:32px;font-weight:700;letter-spacing:8px;color:${PRIMARY}">${escapeHtml(options.code)}</p>`
    : "";
  const action = options.action
    ? `<p style="margin:8px 0 24px"><a href="${escapeHtml(options.action.url)}" style="display:inline-block;background:${PRIMARY};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">${escapeHtml(options.action.label)}</a></p>
       <p style="margin:0 0 16px;font-size:12px;color:#5b6475;word-break:break-all">Or paste this link into your browser: ${escapeHtml(options.action.url)}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f7f7f7;font-family:Arial,Helvetica,sans-serif;color:#0b1b33">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:${PRIMARY};color:#ffffff;padding:16px 24px;font-weight:700;font-size:18px">${escapeHtml(options.brand)}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(options.heading)}</h1>
${body}${code}${action}
<p style="margin:24px 0 0;font-size:12px;color:#5b6475">${escapeHtml(options.footer)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

const NOT_YOU = "If you didn't ask for this, you can ignore this email.";

export function otpEmail(input: {
  brand: string;
  code: string;
  minutes: number;
}): RenderedEmail {
  return {
    subject: `${input.code} is your ${input.brand} sign-in code`,
    html: layout({
      brand: input.brand,
      heading: "Your sign-in code",
      paragraphs: [
        `Enter this code to finish signing in. It expires in ${input.minutes} minutes.`,
      ],
      code: input.code,
      footer: `${NOT_YOU} Never share this code with anyone.`,
    }),
    text: `Your sign-in code is ${input.code}. It expires in ${input.minutes} minutes.\n\n${NOT_YOU}`,
  };
}

export function verifyEmailEmail(input: {
  brand: string;
  name: string;
  url: string;
}): RenderedEmail {
  return {
    subject: `Verify your email for ${input.brand}`,
    html: layout({
      brand: input.brand,
      heading: `Hi ${input.name}, please verify your email`,
      paragraphs: [
        "Confirm this is your email address to finish creating your account.",
      ],
      action: { label: "Verify email", url: input.url },
      footer: NOT_YOU,
    }),
    text: `Hi ${input.name},\n\nVerify your email: ${input.url}\n\n${NOT_YOU}`,
  };
}

export function resetPasswordEmail(input: {
  brand: string;
  url: string;
}): RenderedEmail {
  return {
    subject: `Reset your ${input.brand} password`,
    html: layout({
      brand: input.brand,
      heading: "Reset your password",
      paragraphs: [
        "Use the button below to choose a new password. The link expires in 1 hour.",
      ],
      action: { label: "Choose a new password", url: input.url },
      footer: NOT_YOU,
    }),
    text: `Reset your password: ${input.url}\nThe link expires in 1 hour.\n\n${NOT_YOU}`,
  };
}

export function staffInviteEmail(input: {
  brand: string;
  tenantName: string;
  inviterName: string | null;
  roles: string[];
  url: string;
  expiresAt: Date;
}): RenderedEmail {
  const who = input.inviterName
    ? `${input.inviterName} invited you`
    : "You've been invited";
  const roles = input.roles.join(", ");
  const expires = input.expiresAt.toUTCString();
  return {
    subject: `Join ${input.tenantName} on ${input.brand}`,
    html: layout({
      brand: input.brand,
      heading: `Join ${input.tenantName}`,
      paragraphs: [
        `${who} to join ${input.tenantName} as: ${roles}.`,
        `This invitation expires on ${expires}.`,
      ],
      action: { label: "Accept invitation", url: input.url },
      footer: NOT_YOU,
    }),
    text: `${who} to join ${input.tenantName} as: ${roles}.\nAccept: ${input.url}\nExpires: ${expires}\n\n${NOT_YOU}`,
  };
}

export function ownerInviteEmail(input: {
  brand: string;
  tenantName: string;
  url: string;
  expiresAt: Date;
}): RenderedEmail {
  const expires = input.expiresAt.toUTCString();
  return {
    subject: `Your ${input.brand} account for ${input.tenantName} is ready`,
    html: layout({
      brand: input.brand,
      heading: `Welcome to ${input.brand}`,
      paragraphs: [
        `An account has been set up for ${input.tenantName}, with you as the owner.`,
        `Accept the invitation to sign in and finish setting up. It expires on ${expires}.`,
      ],
      action: { label: "Set up my gym", url: input.url },
      footer: NOT_YOU,
    }),
    text: `An account has been set up for ${input.tenantName}, with you as the owner.\nAccept: ${input.url}\nExpires: ${expires}\n\n${NOT_YOU}`,
  };
}

export function memberAppInviteEmail(input: {
  brand: string;
  tenantName: string;
  name: string;
  url: string;
}): RenderedEmail {
  return {
    subject: `Your ${input.tenantName} member app`,
    html: layout({
      brand: input.brand,
      heading: `Hi ${input.name}, your member app is ready`,
      paragraphs: [
        `${input.tenantName} has set you up in the member app: your membership, dues and receipts in one place.`,
        "Create your password to get started. The link expires in 7 days.",
      ],
      action: { label: "Open the member app", url: input.url },
      footer: NOT_YOU,
    }),
    text: `Hi ${input.name},

${input.tenantName} has set you up in the member app. Create your password: ${input.url}

${NOT_YOU}`,
  };
}
