"use client";

import {
  ActionForm,
  Alert,
  FormField,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import { useState } from "react";
import { CopyButton } from "../../../invoices/[id]/copy-button";
import { createApiKeyAction } from "../actions";

/** Shows a new key once, right after it is created (it is never shown again). */
export function NewKeyForm({
  branches,
}: {
  branches: { value: string; label: string }[];
}) {
  const [key, setKey] = useState<string | null>(null);
  return (
    <div className="flex max-w-xl flex-col gap-4">
      {key && (
        <Alert tone="warning" title="Copy this key now">
          <code className="block break-all text-xs" data-testid="new-api-key">
            {key}
          </code>
          <div className="mt-2">
            <CopyButton text={key} />
          </div>
        </Alert>
      )}
      <ActionForm
        action={createApiKeyAction}
        resetOnSuccess
        onSuccess={(r) =>
          setKey((r.data as { key?: string } | undefined)?.key ?? null)
        }
        className="flex flex-col gap-3"
      >
        <FormField
          label="Name"
          name="name"
          required
          placeholder="e.g. Main website"
        />
        <SelectField
          label="Leads go to branch"
          name="branchId"
          options={branches}
        />
        <div>
          <SubmitButton>Create key</SubmitButton>
        </div>
      </ActionForm>
    </div>
  );
}
