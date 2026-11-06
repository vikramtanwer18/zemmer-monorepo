import { Alert } from "@gym/ui";

/** Shows ?notice= / ?error= left by a confirm-dialog action after its redirect. */
export function Flash({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const notice = typeof params.notice === "string" ? params.notice : null;
  const error = typeof params.error === "string" ? params.error : null;
  if (!notice && !error) return null;
  return (
    <Alert tone={error ? "danger" : "success"} className="mb-4">
      {error ?? notice}
    </Alert>
  );
}
