import { publicFormView } from "@gym/core/crm";
import { isAppError } from "@gym/core/errors";
import { escapeHtml as esc } from "@gym/integrations/email";
import { captureLead } from "@/lib/lead-capture";
import { services } from "@/lib/services";

/**
 * The embeddable form (inside an iframe on the gym's own site). Plain HTML, no scripts, so it can
 * carry a strict policy: it may be framed only by the sites listed on the form. The hosted page
 * (/l/{gym}/{form}) itself can't be framed at all (X-Frame-Options: DENY).
 */
type Ctx = { params: Promise<{ tenant: string; key: string }> };

const TRACKING = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "referrer",
];

type View = NonNullable<Awaited<ReturnType<typeof publicFormView>>>;

function page(view: View, body: string, embedOrigins: string[]) {
  const ancestors = ["'self'", ...embedOrigins].join(" ");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(view.title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0b1b33;background:#fff}
main{max-width:28rem;margin:0 auto;padding:16px}h1{font-size:1.25rem;margin:.25rem 0 1rem}label{display:flex;flex-direction:column;gap:6px;font-size:.875rem;font-weight:600;margin-bottom:12px}
input,textarea{font:inherit;font-weight:400;padding:10px 12px;border:1px solid #c9d1de;border-radius:6px;width:100%}
.check{flex-direction:row;align-items:flex-start;font-weight:400}.check input{width:20px;height:20px;margin:0}
button{font:inherit;font-weight:600;width:100%;padding:12px;border:0;border-radius:6px;background:#204289;color:#fff;cursor:pointer}
.err{color:#b42318;font-size:.875rem;margin:0 0 12px}.ok{background:#e7f6ec;border-radius:6px;padding:12px}.hp{position:absolute;left:-9999px}small{color:#5b6475}
</style></head><body><main>${body}</main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors ${ancestors}; base-uri 'none'`,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Cache-Control": "no-store",
      },
    },
  );
}

function form(
  view: View,
  tracking: Record<string, string>,
  error: string | null,
) {
  const hidden = Object.entries(tracking)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const field = (name: string, label: string, extra = "") =>
    `<label>${esc(label)}<input name="${name}" ${extra}></label>`;
  return `<h1>${esc(view.title)}</h1>${view.intro ? `<p>${esc(view.intro)}</p>` : ""}
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post">${hidden}
<div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
${field("firstName", "Your name", 'required autocomplete="given-name"')}
${field("phone", "Mobile number", 'required inputmode="tel" autocomplete="tel"')}
${view.fields.includes("email") ? field("email", "Email (optional)", 'type="email" autocomplete="email"') : ""}
${view.fields.includes("interest") ? field("interest", "What are you looking for? (optional)") : ""}
${view.fields.includes("preferredTime") ? field("preferredTime", "Best time to call (optional)") : ""}
${view.fields.includes("message") ? `<label>Message (optional)<textarea name="message" rows="3"></textarea></label>` : ""}
<label class="check"><input type="checkbox" name="consent" value="on" required><span>${esc(view.consentText)}</span></label>
${view.marketingText ? `<label class="check"><input type="checkbox" name="marketing" value="on"><span>${esc(view.marketingText)}</span></label>` : ""}
<button type="submit">Send</button></form>
<p><small>${esc(view.tenantName)} · ${esc(view.branchName)}</small></p>`;
}

export async function GET(request: Request, { params }: Ctx) {
  const { tenant, key } = await params;
  const view = await publicFormView(services().deps, tenant, key);
  if (!view) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const tracking = Object.fromEntries(
    TRACKING.map((k) => [
      k,
      url.searchParams.get(k)?.slice(0, 300) ?? "",
    ]).filter(([, v]) => v),
  );
  return page(view, form(view, tracking, null), view.embedOrigins);
}

export async function POST(request: Request, { params }: Ctx) {
  const { tenant, key } = await params;
  const view = await publicFormView(services().deps, tenant, key);
  if (!view) return new Response("Not found", { status: 404 });
  const data = await request.formData();
  const body = Object.fromEntries(
    [...data.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]),
  );
  const tracking = Object.fromEntries(
    TRACKING.map((k) => [k, String(body[k] ?? "")]).filter(([, v]) => v),
  );
  try {
    const result = await captureLead({
      tenantSlug: tenant,
      key,
      body,
      headers: request.headers,
    });
    if (!result.ok) return new Response("Not found", { status: 404 });
    return page(
      view,
      `<div class="ok" role="status"><strong>Thank you!</strong><p>${esc(result.thankYou)}</p></div>`,
      view.embedOrigins,
    );
  } catch (err) {
    if (isAppError(err)) {
      const message = err.fields
        ? Object.values(err.fields).flat().join(" ")
        : err.message;
      return page(view, form(view, tracking, message), view.embedOrigins);
    }
    throw err;
  }
}
