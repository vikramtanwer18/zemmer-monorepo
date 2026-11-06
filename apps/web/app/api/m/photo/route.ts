import { myPhotoUrl } from "@gym/core/members";
import { getMemberSession } from "@/lib/member-session";
import { services } from "@/lib/services";

/** The member's own photo for the digital card. */
export async function GET() {
  const state = await getMemberSession();
  if (state.kind !== "ready")
    return new Response("Sign in first", { status: 401 });
  const url = await myPhotoUrl(services().deps, services().storage, state.mctx);
  if (!url) return new Response("No photo", { status: 404 });
  return new Response(null, {
    status: 302,
    headers: { Location: url, "Cache-Control": "private, no-store" },
  });
}
