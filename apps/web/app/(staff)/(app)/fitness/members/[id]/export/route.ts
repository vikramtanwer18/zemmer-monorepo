import { exportMemberFitnessData } from "@gym/core/fitness";
import { isAppError } from "@gym/core/errors";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

/** fitness.export (Owner/Admin): a member's health and fitness data as JSON. Audited. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { filename, json } = await exportMemberFitnessData(
      services().deps,
      await getAuthContext(),
      id,
    );
    return new Response(json, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (isAppError(err))
      return new Response(err.message, {
        status:
          err.code === "FORBIDDEN" ? 403 : err.code === "NOT_FOUND" ? 404 : 400,
      });
    throw err;
  }
}
