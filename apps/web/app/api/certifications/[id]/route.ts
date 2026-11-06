import { isAppError } from "@gym/core/errors";
import { certificateDownloadUrl } from "@gym/core/staff";
import { services } from "@/lib/services";
import { getSessionState } from "@/lib/session";

/** A trainer's certificate file (staff.view on that staff member). 60-second link. */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return new Response("Not found", { status: 404 });
  const state = await getSessionState();
  if (state.kind !== "ready")
    return new Response("Sign in first", { status: 401 });
  try {
    const url = await certificateDownloadUrl(
      services().deps,
      services().storage,
      state.ctx,
      id,
    );
    return new Response(null, {
      status: 302,
      headers: { Location: url, "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    if (isAppError(err))
      return new Response(err.message, {
        status: err.code === "NOT_FOUND" ? 404 : err.status,
      });
    throw err;
  }
}
