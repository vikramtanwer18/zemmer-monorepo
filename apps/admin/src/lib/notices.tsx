import { Alert } from "@gym/ui";

/** ?notice= / ?error= from a redirecting server action. */
export function Notices({
  sp,
}: {
  sp: Record<string, string | string[] | undefined>;
}) {
  return (
    <>
      {typeof sp.notice === "string" && (
        <Alert tone="success" className="mb-4">
          {sp.notice}
        </Alert>
      )}
      {typeof sp.error === "string" && (
        <Alert tone="danger" className="mb-4">
          {sp.error}
        </Alert>
      )}
    </>
  );
}
