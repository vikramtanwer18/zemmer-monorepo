"use client";

import { Alert, Button } from "@gym/ui";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  confirmDocumentUploadAction,
  requestDocumentUploadAction,
} from "../actions";

const TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const MAX = 5 * 1024 * 1024;

/** Presigned upload straight to private storage, then the server checks and records it. */
export function DocumentUploader({ memberId }: { memberId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    tone: "danger" | "success";
    text: string;
  } | null>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    setStatus(null);
    if (!file) return setStatus({ tone: "danger", text: "Choose a file." });
    if (!title.trim())
      return setStatus({ tone: "danger", text: "Give the document a title." });
    if (!TYPES.includes(file.type))
      return setStatus({
        tone: "danger",
        text: "PDF, JPEG, PNG or WebP only.",
      });
    if (file.size > MAX)
      return setStatus({
        tone: "danger",
        text: "The file must be 5 MB or smaller.",
      });
    setBusy(true);
    try {
      const ticket = await requestDocumentUploadAction(memberId, {
        contentType: file.type,
        size: file.size,
        filename: file.name,
      });
      if (!ticket.ok) throw new Error(ticket.error.message);
      const body = new FormData();
      for (const [k, v] of Object.entries(ticket.data.fields))
        body.append(k, v);
      body.append("file", file);
      const res = await fetch(ticket.data.url, { method: "POST", body });
      if (!res.ok) throw new Error("The upload was rejected.");
      const saved = await confirmDocumentUploadAction(memberId, {
        key: ticket.data.key,
        title: title.trim(),
        filename: file.name,
      });
      if (!saved.ok) throw new Error(saved.error.message);
      setStatus({ tone: "success", text: "Document added." });
      setTitle("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (err) {
      setStatus({
        tone: "danger",
        text: err instanceof Error ? err.message : "Upload failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold">Add a document</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            className="h-10 rounded-md border border-border bg-surface px-3 font-normal"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          File (PDF or image, up to 5 MB)
          <input
            ref={fileRef}
            type="file"
            accept={TYPES.join(",")}
            className="text-sm font-normal"
          />
        </label>
      </div>
      <div>
        <Button onClick={upload} loading={busy} variant="outline">
          Upload
        </Button>
      </div>
      {status && <Alert tone={status.tone}>{status.text}</Alert>}
    </div>
  );
}
