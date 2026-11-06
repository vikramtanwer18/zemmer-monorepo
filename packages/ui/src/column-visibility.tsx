"use client";

import { Columns3 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

/**
 * Lets users hide DataTable columns. Works with server-rendered tables: hidden columns are
 * removed with a scoped CSS rule on their data-col cells.
 */
export function ColumnVisibility({
  columns,
  defaultHidden = [],
  children,
}: {
  columns: { key: string; header: string }[];
  defaultHidden?: string[];
  children: ReactNode;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [hidden, setHidden] = useState(() => new Set(defaultHidden));
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const css = [...hidden]
    .map(
      (key) =>
        `[data-colvis="${id}"] [data-col="${CSS.escape(key)}"]{display:none}`,
    )
    .join("");
  return (
    <div data-colvis={id}>
      {css && <style>{css}</style>}
      <details className="relative mb-2 flex justify-end">
        <summary className="ml-auto inline-flex cursor-pointer list-none items-center gap-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-background">
          <Columns3 aria-hidden="true" className="size-4" />
          Columns
        </summary>
        <fieldset className="absolute right-0 top-full z-20 mt-1 flex min-w-44 flex-col gap-2 rounded-md border border-border bg-surface p-3 shadow-lg">
          <legend className="sr-only">Visible columns</legend>
          {columns.map((col) => (
            <label key={col.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!hidden.has(col.key)}
                onChange={() => toggle(col.key)}
                className="size-4 accent-primary"
              />
              {col.header}
            </label>
          ))}
        </fieldset>
      </details>
      {children}
    </div>
  );
}
