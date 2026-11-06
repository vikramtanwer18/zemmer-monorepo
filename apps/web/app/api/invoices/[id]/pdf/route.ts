import { getInvoice } from "@gym/core/billing";
import { isAppError } from "@gym/core/errors";
import { getMyInvoice } from "@gym/core/members";
import { invoicePdfResponse } from "@/lib/invoice-pdf";
import { getMemberSession } from "@/lib/member-session";
import { services } from "@/lib/services";
import { getSessionState } from "@/lib/session";

/** Invoice PDF for staff with billing.view on its branch, or for the member it belongs to. */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return new Response("Not found", { status: 404 });
  try {
    const state = await getSessionState();
    if (
      state.kind === "ready" &&
      state.ctx.grants.some((g) => g.permissions.has("billing.view"))
    ) {
      await getInvoice(services().deps, state.ctx, id);
      return await invoicePdfResponse(state.ctx.tenantId, id);
    }
    const member = await getMemberSession();
    if (member.kind === "ready") {
      await getMyInvoice(services().db, member.mctx, id);
      return await invoicePdfResponse(member.mctx.tenantId, id);
    }
    return new Response("Sign in first", { status: 401 });
  } catch (err) {
    if (isAppError(err))
      return new Response(err.message, {
        status: err.code === "NOT_FOUND" ? 404 : err.status,
      });
    throw err;
  }
}
