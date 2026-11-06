"use client";

import { Button } from "@gym/ui";
import { useState } from "react";

/** Copies a payment link (to paste into WhatsApp or SMS until M6 sends them). */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-url={text}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => window.prompt("Copy the link:", text));
      }}
    >
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
