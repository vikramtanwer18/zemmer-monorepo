"use client";

import { Alert, Button } from "@gym/ui";
import { useEffect, useRef, useState, useTransition } from "react";
import { embeddedSignupAction } from "./embedded-actions";

type FB = {
  init(o: Record<string, unknown>): void;
  login(
    cb: (r: { authResponse?: { code?: string } }) => void,
    o: Record<string, unknown>,
  ): void;
};
declare global {
  interface Window {
    FB?: FB;
    fbAsyncInit?: () => void;
  }
}

const GRAPH_VERSION = "v27.0";

/**
 * Meta Embedded Signup: Facebook's popup creates or picks the gym's WABA and number, we get a
 * one-time code (exchanged for a token on the server) plus the WABA and phone number ids
 * (window message from facebook.com). Only rendered when the platform switched it on.
 */
export function EmbeddedSignupButton({
  appId,
  configId,
}: {
  appId: string;
  configId: string;
}) {
  // Already loaded (e.g. after client navigation): ready at once.
  const [ready, setReady] = useState(
    () => typeof window !== "undefined" && !!window.FB,
  );
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const session = useRef<{ wabaId?: string; phoneNumberId?: string }>({});

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!/^https:\/\/([a-z]+\.)?facebook\.com$/.test(event.origin)) return;
      try {
        const data =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type === "WA_EMBEDDED_SIGNUP" && data.event === "FINISH")
          session.current = {
            wabaId: data.data?.waba_id,
            phoneNumberId: data.data?.phone_number_id,
          };
      } catch {
        /* not ours */
      }
    };
    window.addEventListener("message", onMessage);
    window.fbAsyncInit = () => {
      window.FB?.init({
        appId,
        autoLogAppEvents: true,
        xfbml: false,
        version: GRAPH_VERSION,
      });
      setReady(true);
    };
    if (!document.getElementById("facebook-jssdk")) {
      const s = document.createElement("script");
      s.id = "facebook-jssdk";
      s.async = true;
      s.crossOrigin = "anonymous";
      s.src = "https://connect.facebook.net/en_US/sdk.js";
      document.body.appendChild(s);
    }
    return () => window.removeEventListener("message", onMessage);
  }, [appId]);

  const launch = () => {
    setError(null);
    window.FB?.login(
      (response) => {
        const code = response.authResponse?.code;
        const { wabaId, phoneNumberId } = session.current;
        if (!code || !wabaId || !phoneNumberId) {
          setError(
            "Sign-up wasn't finished. Try again, or use Manual Connect.",
          );
          return;
        }
        start(async () => {
          const r = await embeddedSignupAction({ code, wabaId, phoneNumberId });
          if (r.ok) setDone("Connected. Reloading…");
          else setError(r.error.message);
          if (r.ok) window.location.reload();
        });
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: "3" },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Log in with Facebook, pick or create your WhatsApp Business Account and
        number, and you're done.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {done && <Alert tone="success">{done}</Alert>}
      <div>
        <Button type="button" onClick={launch} disabled={!ready || pending}>
          {pending ? "Connecting…" : "Connect with Facebook"}
        </Button>
      </div>
    </div>
  );
}
