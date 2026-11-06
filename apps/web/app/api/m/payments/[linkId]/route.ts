import { isAppError } from "@gym/core/errors";
import { myPaymentStatus } from "@gym/core/payments";
import { getMemberSession } from "@/lib/member-session";
import { services } from "@/lib/services";

/** Polled by the "Confirming payment…" page. Reports our records (and a provider re-check). */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { linkId } = await params;
  const state = await getMemberSession();
  if (state.kind !== "ready")
    return Response.json({ error: "signed-out" }, { status: 401 });
  try {
    const status = await myPaymentStatus(services().deps, state.mctx, linkId);
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (isAppError(err))
      return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
