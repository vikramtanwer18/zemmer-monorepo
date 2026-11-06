"use client";

import { Alert, Button } from "@gym/ui";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  requestImportUploadAction as memberUpload,
  startImportAction as memberStart,
} from "../actions";

/** Uploads the CSV to private storage and starts a dry-run check. */
export function ImportUploader({
  requestImportUploadAction = memberUpload,
  startImportAction = memberStart,
}: {
  requestImportUploadAction?: typeof memberUpload;
  startImportAction?: typeof memberStart;
} = {}) {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    const file = ref.current?.files?.[0];
    setError(null);
    if (!file) return setError("Choose a CSV file.");
    if (!/\.csv$/i.test(file.name))
      return setError("Save the sheet as CSV first.");
    if (file.size > 5 * 1024 * 1024)
      return setError("The file must be 5 MB or smaller.");
    setBusy(true);
    try {
      const ticket = await requestImportUploadAction({ size: file.size });
      if (!ticket.ok) throw new Error(ticket.error.message);
      const body = new FormData();
      for (const [k, v] of Object.entries(ticket.data.fields))
        body.append(k, v);
      body.append("file", new File([file], file.name, { type: "text/csv" }));
      const res = await fetch(ticket.data.url, { method: "POST", body });
      if (!res.ok) throw new Error("The upload was rejected.");
      const job = await startImportAction({
        key: ticket.data.key,
        filename: file.name,
        size: file.size,
        dryRun: true,
      });
      if (!job.ok) throw new Error(job.error.message);
      if (ref.current) ref.current.value = "";
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        CSV file
        <input
          ref={ref}
          type="file"
          accept=".csv,text/csv"
          className="text-sm font-normal"
        />
      </label>
      <div>
        <Button onClick={start} loading={busy}>
          Check the file
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
