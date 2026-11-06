"use client";

import { Badge, Button } from "@gym/ui";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useRef, useState } from "react";
import { bulkMembersAction } from "./actions";

type Row = {
  id: string;
  name: string;
  code: string;
  contact: string;
  branch: string;
  joined: string;
  status: string;
  tags: string[];
  membership: {
    label: string;
    state: string;
    tone: "success" | "info" | "warning" | "neutral";
  } | null;
};

const STATE_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  PAUSED: "Frozen",
  PENDING_PAYMENT: "Awaiting payment",
  EXPIRED: "Expired",
};

/** Member list with selection and confirmed bulk actions (assign branch, add tag, archive). */
export function MemberTable({
  rows,
  canEdit,
  branches,
  back,
  sort,
  sortHref,
}: {
  rows: Row[];
  canEdit: boolean;
  branches: { id: string; name: string }[];
  back: string;
  sort: { key: string; dir: string };
  sortHref: { name: string; joinedAt: string };
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState("add_tag");
  const dialog = useRef<HTMLDialogElement>(null);
  const all = rows.length > 0 && selected.size === rows.length;
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const sortIcon = (key: string) =>
    sort.key === key ? (
      sort.dir === "asc" ? (
        <ArrowUp aria-hidden="true" className="size-3" />
      ) : (
        <ArrowDown aria-hidden="true" className="size-3" />
      )
    ) : null;
  const ariaSort = (key: string) =>
    sort.key === key
      ? sort.dir === "asc"
        ? "ascending"
        : "descending"
      : "none";

  return (
    <>
      {canEdit && selected.size > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-2 text-sm"
        >
          <span className="font-medium">{selected.size} selected</span>
          <label htmlFor="bulk-action" className="sr-only">
            Action
          </label>
          <select
            id="bulk-action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="h-9 rounded-md border border-border bg-surface px-2"
          >
            <option value="add_tag">Add a tag</option>
            <option value="assign_branch">Move to branch</option>
            <option value="archive">Archive</option>
            <option value="restore">Restore</option>
          </select>
          <Button size="sm" onClick={() => dialog.current?.showModal()}>
            Continue
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}
      <dialog
        ref={dialog}
        aria-labelledby="bulk-title"
        className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-lg border border-border bg-surface p-0 shadow-xl backdrop:bg-foreground/40"
      >
        <form
          action={bulkMembersAction}
          className="flex flex-col gap-4 p-6"
          onSubmit={() => dialog.current?.close()}
        >
          <h2 id="bulk-title" className="text-lg font-semibold">
            {action === "archive"
              ? "Archive"
              : action === "restore"
                ? "Restore"
                : action === "assign_branch"
                  ? "Move"
                  : "Tag"}{" "}
            {selected.size} member
            {selected.size === 1 ? "" : "s"}?
          </h2>
          {[...selected].map((id) => (
            <input key={id} type="hidden" name="memberIds" value={id} />
          ))}
          <input type="hidden" name="action" value={action} />
          <input type="hidden" name="back" value={back} />
          {action === "add_tag" && (
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Tag
              <input
                name="tag"
                required
                maxLength={30}
                className="h-10 rounded-md border border-border bg-surface px-3 font-normal"
              />
            </label>
          )}
          {action === "assign_branch" && (
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Branch
              <select
                name="branchId"
                required
                className="h-10 rounded-md border border-border bg-surface px-2 font-normal"
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {action === "archive" && (
            <p className="text-sm text-muted">
              Archived members stay in your records and reports. Members with a
              running membership can't be archived.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={action === "archive" ? "danger" : "primary"}
            >
              Confirm
            </Button>
          </div>
        </form>
      </dialog>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Members</caption>
          <thead className="border-b border-border bg-background text-xs uppercase tracking-wide text-muted">
            <tr>
              {canEdit && (
                <th scope="col" className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={all}
                    onChange={() =>
                      setSelected(
                        all ? new Set() : new Set(rows.map((r) => r.id)),
                      )
                    }
                    className="size-4 accent-primary"
                  />
                </th>
              )}
              <th
                scope="col"
                aria-sort={ariaSort("name")}
                className="px-4 py-3 font-medium"
              >
                <a
                  href={sortHref.name}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  Member {sortIcon("name")}
                </a>
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Membership
              </th>
              <th
                scope="col"
                className="hidden px-4 py-3 font-medium md:table-cell"
              >
                Branch
              </th>
              <th
                scope="col"
                aria-sort={ariaSort("joinedAt")}
                className="hidden px-4 py-3 font-medium sm:table-cell"
              >
                <a
                  href={sortHref.joinedAt}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  Joined {sortIcon("joinedAt")}
                </a>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                {canEdit && (
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name}`}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      className="size-4 accent-primary"
                    />
                  </td>
                )}
                <td className="px-4 py-3">
                  <a
                    href={`/members/${r.id}`}
                    className="font-medium text-primary underline"
                  >
                    {r.name}
                  </a>
                  <div className="text-xs text-muted">
                    {r.code} · {r.contact}
                  </div>
                  {(r.status !== "ACTIVE" || r.tags.length > 0) && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.status === "PENDING_APPROVAL" && (
                        <Badge tone="warning">Awaiting approval</Badge>
                      )}
                      {r.status === "ARCHIVED" && <Badge>Archived</Badge>}
                      {r.tags.map((t) => (
                        <Badge key={t} tone="info">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  {r.membership ? (
                    <div className="flex flex-col gap-1">
                      <Badge tone={r.membership.tone}>
                        {STATE_LABEL[r.membership.state] ?? r.membership.state}
                      </Badge>
                      <span className="text-xs text-muted">
                        {r.membership.label}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted">No membership</span>
                  )}
                </td>
                <td className="hidden px-4 py-3 md:table-cell">{r.branch}</td>
                <td className="hidden px-4 py-3 sm:table-cell">{r.joined}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
