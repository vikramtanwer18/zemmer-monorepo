"use client";

import { Alert, Button } from "@gym/ui";
import { useRef, useState } from "react";
import { confirmLogoUploadAction, requestLogoUploadAction } from "../actions";

const TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 1024 * 1024;

/**
 * Uploads straight to storage with a presigned POST (the server never streams the file), then
 * asks the server to verify and save it. Type and size are checked here for a quick message and
 * enforced again by storage and the server.
 */
export function LogoUploader({
  currentUrl,
  disabled,
}: {
  currentUrl: string | null;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(currentUrl);
  const [status, setStatus] = useState<{
    tone: "danger" | "success";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setStatus(null);
    if (!TYPES.includes(file.type)) {
      setStatus({ tone: "danger", text: "Choose a PNG, JPEG or WebP image." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus({ tone: "danger", text: "The logo must be 1 MB or smaller." });
      return;
    }
    setBusy(true);
    try {
      const ticket = await requestLogoUploadAction({
        contentType: file.type,
        size: file.size,
      });
      if (!ticket.ok) throw new Error(ticket.error.message);
      const body = new FormData();
      for (const [key, value] of Object.entries(ticket.data.fields))
        body.append(key, value);
      body.append("file", file);
      const response = await fetch(ticket.data.url, { method: "POST", body });
      if (!response.ok)
        throw new Error(
          "The upload was rejected. Check the file and try again.",
        );
      const saved = await confirmLogoUploadAction(ticket.data.key);
      if (!saved.ok) throw new Error(saved.error.message);
      setPreview(URL.createObjectURL(file));
      setStatus({ tone: "success", text: "Logo updated." });
    } catch (err) {
      setStatus({
        tone: "danger",
        text: err instanceof Error ? err.message : "Upload failed.",
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <div className="flex size-20 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived presigned URL
            <img
              src={preview}
              alt="Current logo"
              className="size-full object-contain"
            />
          ) : (
            <span className="text-xs text-muted">No logo</span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="logo-file" className="sr-only">
            Logo file
          </label>
          <input
            ref={inputRef}
            id="logo-file"
            type="file"
            accept={TYPES.join(",")}
            className="sr-only"
            disabled={disabled || busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            loading={busy}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {preview ? "Replace logo" : "Upload logo"}
          </Button>
          <p className="text-xs text-muted">PNG, JPEG or WebP, up to 1 MB.</p>
        </div>
      </div>
      {status && <Alert tone={status.tone}>{status.text}</Alert>}
    </div>
  );
}
