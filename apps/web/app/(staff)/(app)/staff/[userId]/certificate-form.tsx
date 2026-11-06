"use client";

import { Alert, Button } from "@gym/ui";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  addCertificationAction,
  requestCertificateUploadAction,
} from "./actions";

const TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const MAX = 5 * 1024 * 1024;

/** Adds a certification; the optional file goes straight to private storage first. */
export function CertificateForm({ trainerId }: { trainerId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fields, setFields] = useState({
    title: "",
    issuer: "",
    issuedOn: "",
    expiresOn: "",
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    tone: "danger" | "success";
    text: string;
  } | null>(null);

  async function save() {
    setStatus(null);
    const file = fileRef.current?.files?.[0];
    if (!fields.title.trim())
      return setStatus({ tone: "danger", text: "Name the certification." });
    if (file && !TYPES.includes(file.type))
      return setStatus({
        tone: "danger",
        text: "PDF, JPEG, PNG or WebP only.",
      });
    if (file && file.size > MAX)
      return setStatus({
        tone: "danger",
        text: "The file must be 5 MB or smaller.",
      });
    setBusy(true);
    try {
      let key: string | undefined;
      if (file) {
        const ticket = await requestCertificateUploadAction(trainerId, {
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
        key = ticket.data.key;
      }
      const saved = await addCertificationAction(trainerId, {
        ...fields,
        key,
        filename: file?.name,
      });
      if (!saved.ok) throw new Error(saved.error.message);
      setFields({ title: "", issuer: "", issuedOn: "", expiresOn: "" });
      if (fileRef.current) fileRef.current.value = "";
      setStatus({ tone: "success", text: "Certification added." });
      router.refresh();
    } catch (err) {
      setStatus({
        tone: "danger",
        text: err instanceof Error ? err.message : "Saving failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  const input =
    "h-10 rounded-md border border-border bg-surface px-3 font-normal";
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Certification
          <input
            className={input}
            value={fields.title}
            onChange={(e) => setFields({ ...fields, title: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Issued by
          <input
            className={input}
            value={fields.issuer}
            onChange={(e) => setFields({ ...fields, issuer: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Issued on
          <input
            type="date"
            className={input}
            value={fields.issuedOn}
            onChange={(e) => setFields({ ...fields, issuedOn: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Expires on
          <input
            type="date"
            className={input}
            value={fields.expiresOn}
            onChange={(e) =>
              setFields({ ...fields, expiresOn: e.target.value })
            }
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Certificate file (optional, PDF or image, up to 5 MB)
        <input
          ref={fileRef}
          type="file"
          accept={TYPES.join(",")}
          className="text-sm font-normal"
        />
      </label>
      <div>
        <Button onClick={save} loading={busy} variant="outline">
          Add certification
        </Button>
      </div>
      {status && <Alert tone={status.tone}>{status.text}</Alert>}
    </div>
  );
}
