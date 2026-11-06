"use client";

import { Button } from "@gym/ui";
import { useEffect, useState } from "react";

/** Rest countdown between sets. Purely local; vibrates at the end where the phone allows it. */
export function RestTimer({ seconds }: { seconds: number }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (left === null) return;
    if (left <= 0) {
      if ("vibrate" in navigator) navigator.vibrate?.(300);
      const t = setTimeout(() => setLeft(null), 1500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(
      () => setLeft((v) => (v === null ? null : v - 1)),
      1000,
    );
    return () => clearTimeout(t);
  }, [left]);
  if (left === null)
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setLeft(seconds)}
      >
        Rest {seconds}s
      </Button>
    );
  return (
    <span
      className="flex items-center gap-2 text-sm"
      role="timer"
      aria-live="polite"
    >
      <span className="font-mono text-lg tabular-nums">
        {left > 0
          ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
          : "Go!"}
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setLeft(null)}
      >
        Stop
      </Button>
    </span>
  );
}
