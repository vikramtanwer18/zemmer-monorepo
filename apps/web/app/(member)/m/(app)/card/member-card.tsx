"use client";

import {
  fromBase64Url,
  msUntilNextStep,
  passCodeAt,
} from "@gym/core/pass-code";
import { Alert, Badge } from "@gym/ui";
import { Sun, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { QrCode } from "@/components/qr-code";
import {
  loadCard,
  saveCard,
  wipeCard,
  type StoredCard,
} from "@/lib/card-store";

const STALE_MS = 24 * 60 * 60 * 1000;

type State =
  | { kind: "loading" }
  | { kind: "ready"; card: StoredCard; offline: boolean; stale: boolean }
  | { kind: "signed-out" }
  | { kind: "error"; message: string };

function syncedLabel(ms: number) {
  return new Date(ms).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function MemberCard({ userId }: { userId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [code, setCode] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [photoOk, setPhotoOk] = useState(true);
  const stepRef = useRef<number | null>(null);

  // 1) Show the offline copy at once; 2) refresh from the server when online.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await loadCard();
      // Another account's copy on a shared phone is never shown.
      if (cached && cached.userId !== userId) await wipeCard();
      else if (cached && !cancelled)
        setState({
          kind: "ready",
          card: cached,
          offline: !navigator.onLine,
          stale: Date.now() - cached.syncedAt > STALE_MS,
        });
      try {
        const res = await fetch("/api/m/card", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (res.status === 401 || res.status === 403) {
          await wipeCard();
          if (!cancelled) setState({ kind: "signed-out" });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Omit<
          StoredCard,
          "syncedAt" | "clockOffsetMs"
        > & { serverTime: string };
        const fresh: StoredCard = {
          tenantId: data.tenantId,
          userId: data.userId,
          member: data.member,
          gym: data.gym,
          branch: data.branch,
          membership: data.membership,
          pass: data.pass,
          passRevoked: data.passRevoked,
          syncedAt: Date.now(),
          clockOffsetMs: new Date(data.serverTime).getTime() - Date.now(),
        };
        if (fresh.pass) await saveCard(fresh);
        else await wipeCard(); // revoked: the device copy goes too
        if (!cancelled)
          setState({
            kind: "ready",
            card: fresh,
            offline: false,
            stale: false,
          });
      } catch {
        if (!cancelled)
          setState((s) =>
            s.kind === "ready"
              ? { ...s, offline: true }
              : {
                  kind: "error",
                  message:
                    "You're offline and this phone has no saved card yet. Open the card once with a connection.",
                },
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Rotate the code every 30 seconds (server clock, corrected for this phone's drift).
  const shown = state.kind === "ready" ? state.card : null;
  useEffect(() => {
    if (!shown?.pass) return;
    const pass = shown.pass;
    const secret = fromBase64Url(pass.secret);
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const now = Date.now() + shown.clockOffsetMs;
      setSecondsLeft(Math.ceil(msUntilNextStep(now) / 1000));
      const next = await passCodeAt(secret, pass.passId, now);
      if (next.timeStep !== stepRef.current) {
        stepRef.current = next.timeStep;
        setCode(next.code);
      }
      timer = setTimeout(tick, 1000 - (now % 1000) + 5);
    };
    void tick();
    return () => clearTimeout(timer);
  }, [shown]);

  // Keep the screen on while the card is shown (where supported).
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: {
        request(type: "screen"): Promise<{ release(): Promise<void> }>;
      };
    };
    nav.wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    return () => {
      void lock?.release();
    };
  }, []);

  if (state.kind === "loading")
    return (
      <div className="flex flex-col items-center gap-3 py-10" aria-busy="true">
        <div className="size-64 animate-pulse rounded-lg bg-foreground/5" />
        <p className="text-sm text-muted">Loading your card…</p>
      </div>
    );
  if (state.kind === "signed-out")
    return (
      <Alert tone="warning" title="Signed out">
        Sign in again to show your card.{" "}
        <a href="/m/sign-in?next=/m/card" className="underline">
          Sign in
        </a>
      </Alert>
    );
  if (state.kind === "error")
    return (
      <Alert tone="warning" title="No card on this phone yet">
        {state.message}
      </Alert>
    );

  const c = state.card;
  const isStale = state.stale;
  return (
    <div className="flex flex-col items-center gap-4">
      {state.offline && (
        <Alert tone={isStale ? "warning" : "info"} className="w-full">
          <span className="inline-flex items-center gap-1.5">
            <WifiOff aria-hidden="true" className="size-4" /> Offline. The code
            still works.
          </span>
          {isStale && (
            <span className="block">
              Membership details last synced {syncedLabel(c.syncedAt)}.
            </span>
          )}
        </Alert>
      )}
      <section
        aria-label="Membership card"
        className="w-full overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
      >
        <div className="flex items-center gap-3 bg-primary px-4 py-3 text-primary-foreground">
          {c.member.hasPhoto && photoOk && !state.offline ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src="/api/m/photo"
              alt=""
              onError={() => setPhotoOk(false)}
              className="size-14 rounded-full border-2 border-white/60 object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex size-14 items-center justify-center rounded-full bg-white/20 text-xl font-semibold"
            >
              {c.member.name
                .split(" ")
                .map((p) => p[0])
                .join("")
                .slice(0, 2)
                .toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold">{c.member.name}</p>
            <p className="text-sm opacity-90">
              {c.gym} · {c.branch}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-center gap-3 p-5">
          {c.pass && code ? (
            <>
              <QrCode
                value={code}
                label="Your check-in code. Show it to the front desk."
                className="size-64 max-w-full"
              />
              <p className="text-sm text-muted" aria-live="off">
                New code in{" "}
                <span className="font-semibold tabular-nums">
                  {secondsLeft}
                </span>
                s
              </p>
              <div
                className="h-1 w-48 overflow-hidden rounded-full bg-foreground/10"
                aria-hidden="true"
              >
                <div
                  className="h-full bg-primary transition-[width] duration-1000 ease-linear"
                  style={{
                    width: `${(secondsLeft / (c.pass.stepSeconds || 30)) * 100}%`,
                  }}
                />
              </div>
            </>
          ) : c.passRevoked ? (
            <Alert tone="warning" title="Your pass was cancelled">
              Ask the front desk for a new one.
            </Alert>
          ) : (
            <div className="size-64 animate-pulse rounded-lg bg-foreground/5" />
          )}
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Sun aria-hidden="true" className="size-4" /> Turn your screen
            brightness up for faster scanning.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-3 border-t border-border px-5 py-4 text-sm">
          <div>
            <dt className="text-muted">Member</dt>
            <dd className="font-medium">{c.member.memberCode}</dd>
          </div>
          <div>
            <dt className="text-muted">Status</dt>
            <dd>
              {c.membership ? (
                <Badge tone={c.membership.active ? "success" : "warning"}>
                  {c.membership.status}
                </Badge>
              ) : (
                <Badge tone="warning">No membership</Badge>
              )}
            </dd>
          </div>
          {c.membership && (
            <>
              <div>
                <dt className="text-muted">Plan</dt>
                <dd className="font-medium">{c.membership.planName}</dd>
              </div>
              <div>
                <dt className="text-muted">Valid until</dt>
                <dd className="font-medium">{c.membership.endDate}</dd>
              </div>
            </>
          )}
        </dl>
      </section>
      <p className="text-center text-xs text-muted">
        Last synced {syncedLabel(c.syncedAt)}. Screenshots don&apos;t work: the
        code changes every 30 seconds and each one works once.
      </p>
    </div>
  );
}
