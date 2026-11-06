"use client";

import { useEffect } from "react";

/** Registers the member app's service worker, scoped to /m/ only. */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/m/sw.js", { scope: "/m/" })
      .catch((err: unknown) => {
        console.error("Service worker registration failed", err);
      });
  }, []);
  return null;
}
