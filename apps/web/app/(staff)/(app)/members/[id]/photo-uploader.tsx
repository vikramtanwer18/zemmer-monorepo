"use client";

import { Alert, Button } from "@gym/ui";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { confirmPhotoUploadAction, requestPhotoUploadAction } from "../actions";

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX = 2 * 1024 * 1024;

/** Member photo for the card and the scan screen. On phones the camera opens directly. */
export function PhotoUploader({
  memberId,
  hasPhoto,
  name,
}: {
  memberId: string;
  hasPhoto: boolean;
  name: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    setError(null);
    if (!file) return;
    if (!TYPES.includes(file.type))
      return setError("JPEG, PNG or WebP photos only.");
    if (file.size > MAX) return setError("The photo must be 2 MB or smaller.");
    setBusy(true);
    try {
      const ticket = await requestPhotoUploadAction(memberId, {
        contentType: file.type,
        size: file.size,
      });
      if (!ticket.ok) throw new Error(ticket.error.message);
      const body = new FormData();
      for (const [k, v] of Object.entries(ticket.data.fields))
        body.append(k, v);
      body.append("file", file);
      const res = await fetch(ticket.data.url, { method: "POST", body });
      if (!res.ok) throw new Error("The upload was rejected.");
      const saved = await confirmPhotoUploadAction(memberId, ticket.data.key);
      if (!saved.ok) throw new Error(saved.error.message);
      setVersion((v) => v + 1);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="flex items-center gap-4">
      {hasPhoto || version > 0 ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/members/${memberId}/photo?v=${version}`}
          alt={`Photo of ${name}`}
          className="size-20 rounded-full object-cover"
        />
      ) : (
        <div
          aria-hidden="true"
          className="flex size-20 items-center justify-center rounded-full bg-primary/10 text-2xl font-semibold text-primary"
        >
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">
          <span className="sr-only">Photo</span>
          <input
            ref={fileRef}
            type="file"
            accept={TYPES.join(",")}
            capture="user"
            onChange={upload}
            className="hidden"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={busy}
            onClick={() => fileRef.current?.click()}
          >
            {hasPhoto ? "Change photo" : "Add photo"}
          </Button>
        </label>
        <p className="text-xs text-muted">
          Shown to staff when the card is scanned.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </div>
  );
}
