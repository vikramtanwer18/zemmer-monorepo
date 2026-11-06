import { isAppError } from "@gym/core/errors";
import { memberPhotoUrl } from "@gym/core/members";
import { services } from "@/lib/services";
import { getSessionState } from "@/lib/session";

/** Member photo for staff who may see the member (scan result, profile). 60-second link. */
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
    const url = await memberPhotoUrl(
      services().deps,
      services().storage,
      state.ctx,
      id,
    );
    if (!url) return new Response("No photo", { status: 404 });
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
