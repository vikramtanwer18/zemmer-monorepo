"use client";

import { Alert, Badge } from "@gym/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { moveLeadFromBoard } from "../actions";

type Column = {
  stage: { id: string; name: string; category: string };
  count: number;
  movable: boolean;
  leads: {
    id: string;
    name: string;
    score: number;
    owner: string | null;
    overdue: boolean;
    nextDue: string | null;
  }[];
};

/**
 * Kanban. Drag a card to another open stage, or use its "Move to" picker (keyboard, phones).
 * Every move is checked on the server (permission, Won/Lost rules) before anything changes.
 */
export function Board({
  columns,
  canMove,
}: {
  columns: Column[];
  canMove: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const targets = columns.filter((c) => c.movable);

  function move(leadId: string, stageId: string) {
    startTransition(async () => {
      const result = await moveLeadFromBoard(leadId, stageId);
      setError(result.ok ? null : result.error.message);
      router.refresh();
    });
  }

  return (
    <>
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div
        className="-mx-4 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0"
        aria-busy={pending}
      >
        <ol className="flex min-w-max gap-3" aria-label="Pipeline stages">
          {columns.map((col) => (
            <li
              key={col.stage.id}
              className={`flex w-64 shrink-0 flex-col rounded-lg border bg-surface ${over === col.stage.id ? "border-primary" : "border-border"}`}
              onDragOver={(e) => {
                if (!canMove || !col.movable || !dragging) return;
                e.preventDefault();
                setOver(col.stage.id);
              }}
              onDragLeave={() =>
                setOver((v) => (v === col.stage.id ? null : v))
              }
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData("text/plain");
                if (id && col.movable) move(id, col.stage.id);
              }}
            >
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <h2 className="text-sm font-semibold">{col.stage.name}</h2>
                <Badge tone="neutral">{col.count}</Badge>
              </div>
              <ul className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto p-2">
                {col.leads.length === 0 && (
                  <li className="px-1 py-3 text-xs text-muted">
                    Nothing here.
                  </li>
                )}
                {col.leads.map((lead) => (
                  <li
                    key={lead.id}
                    draggable={canMove && col.movable}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", lead.id);
                      setDragging(lead.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={`rounded-md border border-border bg-background p-2 text-sm ${canMove && col.movable ? "cursor-grab" : ""}`}
                  >
                    <a
                      href={`/leads/${lead.id}`}
                      className="font-medium text-primary underline"
                    >
                      {lead.name}
                    </a>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
                      <span>{lead.owner ?? "Nobody"}</span>
                      <span className="flex items-center gap-1">
                        {lead.overdue && <Badge tone="danger">overdue</Badge>}
                        <span title="Score">{lead.score}</span>
                      </span>
                    </div>
                    {canMove && col.movable && (
                      <label className="mt-2 flex items-center gap-1 text-xs">
                        <span className="sr-only">Move {lead.name} to</span>
                        <select
                          className="h-8 w-full rounded border border-border bg-surface px-1"
                          value=""
                          onChange={(e) =>
                            e.target.value && move(lead.id, e.target.value)
                          }
                        >
                          <option value="">Move to…</option>
                          {targets
                            .filter((t) => t.stage.id !== col.stage.id)
                            .map((t) => (
                              <option key={t.stage.id} value={t.stage.id}>
                                {t.stage.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
