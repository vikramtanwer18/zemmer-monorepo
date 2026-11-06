"use client";

import { Alert, Button } from "@gym/ui";
import { useActionState } from "react";
import { submitLeadFormAction } from "./actions";

type Props = {
  tenant: string;
  formKey: string;
  fields: string[];
  consentText: string;
  marketingText: string | null;
  tracking: Record<string, string>;
};

const input =
  "h-11 w-full rounded-md border border-border bg-surface px-3 text-base";

/** The visitor's form. Works without JavaScript too (plain POST through the server action). */
export function LeadForm({
  tenant,
  formKey,
  fields,
  consentText,
  marketingText,
  tracking,
}: Props) {
  const [state, action, pending] = useActionState(submitLeadFormAction, null);
  if (state?.ok)
    return (
      <Alert tone="success" title="Thank you!" role="status">
        {state.message}
      </Alert>
    );
  const err = state && !state.ok ? state.error : null;
  const fieldError = (name: string) =>
    err?.fields?.[name]?.[0] ? (
      <span id={`${name}-error`} className="text-sm text-danger">
        {err.fields[name]![0]}
      </span>
    ) : null;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate={false}>
      {err && !err.fields && <Alert tone="danger">{err.message}</Alert>}
      <input type="hidden" name="tenant" value={tenant} />
      <input type="hidden" name="formKey" value={formKey} />
      {Object.entries(tracking).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {/* Honeypot: hidden from people, filled by bots. */}
      <div
        aria-hidden="true"
        className="absolute -left-[9999px] h-0 w-0 overflow-hidden"
      >
        <label>
          Website <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Your name
        <input
          name="firstName"
          required
          autoComplete="given-name"
          className={input}
          aria-describedby="firstName-error"
        />
        {fieldError("firstName")}
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Mobile number
        <input
          name="phone"
          required
          inputMode="tel"
          autoComplete="tel"
          placeholder="98765 43210"
          className={input}
          aria-describedby="phone-error"
        />
        {fieldError("phone")}
      </label>
      {fields.includes("email") && (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Email (optional)
          <input
            name="email"
            type="email"
            autoComplete="email"
            className={input}
            aria-describedby="email-error"
          />
          {fieldError("email")}
        </label>
      )}
      {fields.includes("interest") && (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          What are you looking for? (optional)
          <input
            name="interest"
            placeholder="e.g. weight loss, strength, yoga"
            className={input}
          />
        </label>
      )}
      {fields.includes("preferredTime") && (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Best time to call (optional)
          <input
            name="preferredTime"
            placeholder="e.g. after 6 pm"
            className={input}
          />
        </label>
      )}
      {fields.includes("message") && (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Message (optional)
          <textarea
            name="message"
            rows={3}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-base"
          />
        </label>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="consent"
          value="on"
          required
          className="mt-0.5 size-5"
          aria-describedby="consent-error"
        />
        <span>{consentText}</span>
      </label>
      {fieldError("consent")}
      {marketingText && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="marketing"
            value="on"
            className="mt-0.5 size-5"
          />
          <span>{marketingText}</span>
        </label>
      )}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Sending…" : "Send"}
      </Button>
    </form>
  );
}
