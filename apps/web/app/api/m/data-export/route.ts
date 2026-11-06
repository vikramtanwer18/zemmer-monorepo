import { exportMyData } from "@gym/core/members";
import { getMemberSession } from "@/lib/member-session";
import { services } from "@/lib/services";

/** "Download my data" (M4 privacy minimum): the member's own records as JSON. */
export async function GET() {
  const state = await getMemberSession();
  if (state.kind !== "ready")
    return new Response("Sign in first", { status: 401 });
  const data = await exportMyData(services().deps, state.mctx);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
