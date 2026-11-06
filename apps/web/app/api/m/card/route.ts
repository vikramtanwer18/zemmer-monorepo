import { getMyCard } from "@gym/core/attendance";
import { getMemberSession } from "@/lib/member-session";
import { services } from "@/lib/services";

const NO_STORE = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json",
};

/**
 * The member's digital card, including the pass secret (D-09). Only for the member's own
 * authenticated session; never cached by the browser or the service worker (no-store). The app
 * keeps its own copy in IndexedDB for offline use and wipes it when this says "signed out".
 */
export async function GET() {
  const state = await getMemberSession();
  if (state.kind === "anonymous")
    return new Response(JSON.stringify({ error: "signed-out" }), {
      status: 401,
      headers: NO_STORE,
    });
  if (state.kind !== "ready")
    return new Response(JSON.stringify({ error: "no-gym" }), {
      status: 403,
      headers: NO_STORE,
    });
  const card = await getMyCard(services().deps, state.mctx);
  return new Response(
    JSON.stringify({
      ...card,
      tenantId: state.mctx.tenantId,
      userId: state.user.id,
    }),
    { status: 200, headers: NO_STORE },
  );
}
