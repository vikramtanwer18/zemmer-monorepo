"use client";

import { Button } from "@gym/ui";
import { useEffect, useState, useTransition } from "react";
import { bookMemberAction, searchBookableAction } from "../actions";

type Found = { id: string; name: string; memberCode: string };

/** Find a member and book them (or add them to the waitlist when the class is full). */
export function BookMember({
  sessionId,
  full,
  waitlist,
}: {
  sessionId: string;
  full: boolean;
  waitlist: boolean;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Found | null>(null);
  const [, start] = useTransition();

  const searching = query.trim().length >= 2;
  const visible = searching ? found : [];
  useEffect(() => {
    if (!searching) return;
    const t = setTimeout(
      () =>
        start(async () => {
          const res = await searchBookableAction(query);
          setFound(res.ok ? res.data : []);
        }),
      250,
    );
    return () => clearTimeout(t);
  }, [query, searching]);

  return (
    <form action={bookMemberAction} className="flex flex-col gap-2">
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="memberId" value={picked?.id ?? ""} />
      <input type="hidden" name="waitlist" value={full ? "1" : "0"} />
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Book a member
        <input
          type="search"
          value={picked ? `${picked.name} (${picked.memberCode})` : query}
          onChange={(e) => {
            setPicked(null);
            setQuery(e.target.value);
          }}
          placeholder="Name or member code"
          className="h-10 rounded-md border border-border bg-surface px-3"
        />
      </label>
      {!picked && visible.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {visible.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setPicked(m)}
                className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-background"
              >
                <span className="font-medium">{m.name}</span>
                <span className="text-muted">{m.memberCode}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={!picked || (full && !waitlist)}
        >
          {full ? "Add to waitlist" : "Book"}
        </Button>
      </div>
    </form>
  );
}
