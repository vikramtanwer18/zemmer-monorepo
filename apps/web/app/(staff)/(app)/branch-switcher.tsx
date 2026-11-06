"use client";

import { useRef } from "react";
import { selectBranchAction } from "./actions";

/** Header branch picker. Submits on change; the server checks the branch is allowed. */
export function BranchSwitcher({
  current,
  allowAll,
  branches,
  back,
}: {
  current: string;
  allowAll: boolean;
  branches: { id: string; label: string }[];
  back: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      action={selectBranchAction}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="back" value={back} />
      <label htmlFor="branch-switcher" className="sr-only">
        Current branch
      </label>
      <select
        id="branch-switcher"
        name="branchId"
        defaultValue={current}
        onChange={() => formRef.current?.requestSubmit()}
        className="h-8 max-w-44 rounded-md border border-border bg-surface px-2 text-sm"
      >
        {allowAll && <option value="all">All branches</option>}
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="text-sm underline">
          Go
        </button>
      </noscript>
    </form>
  );
}
