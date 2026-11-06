import "server-only";
import {
  listMyMemberGyms,
  resolveMemberContext,
  type MemberContext,
} from "@gym/core/members";
import { AppError } from "@gym/core/errors";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { services } from "@/lib/services";

/**
 * Member app (PWA) session. Same Better Auth session as the staff app (one global User, D-04),
 * but the context is the member profile in the chosen gym — staff roles play no part here.
 * The gym on the session is re-verified against an ACTIVE member profile on every request.
 */
export type MemberSessionState =
  | { kind: "anonymous" }
  | { kind: "no-gym"; user: { id: string; name: string; email: string } }
  | {
      kind: "pick-gym";
      user: { id: string; name: string; email: string };
      gyms: { tenantId: string; displayName: string }[];
    }
  | {
      kind: "ready";
      user: { id: string; name: string; email: string };
      mctx: MemberContext;
      gyms: { tenantId: string; displayName: string }[];
    };

export const getMemberSession = cache(async (): Promise<MemberSessionState> => {
  const h = new Headers(await headers());
  const { auth, db } = services();
  const result = await auth.api.getSession({ headers: h });
  if (!result) return { kind: "anonymous" };
  const [userRow, session] = await Promise.all([
    db.user.findUnique({ where: { id: result.user.id } }),
    db.session.findUnique({ where: { id: result.session.id } }),
  ]);
  if (!userRow || !session || userRow.status !== "ACTIVE")
    return { kind: "anonymous" };
  const user = { id: userRow.id, name: userRow.name, email: userRow.email };
  const gyms = await listMyMemberGyms(db, user.id);
  if (gyms.length === 0) return { kind: "no-gym", user };
  const chosen =
    gyms.find((g) => g.tenantId === session.activeTenantId) ??
    (gyms.length === 1 ? gyms[0] : undefined);
  if (!chosen) return { kind: "pick-gym", user, gyms };
  const mctx = await resolveMemberContext(db, user.id, chosen.tenantId);
  if (!mctx) return { kind: "pick-gym", user, gyms };
  if (session.activeTenantId !== chosen.tenantId) {
    await db.session.update({
      where: { id: session.id },
      data: { activeTenantId: chosen.tenantId, activeBranchId: null },
    });
  }
  return { kind: "ready", user, mctx, gyms };
});

/** For member server actions: the member context, or an AppError. Re-checked on every call. */
export async function getMemberContext(): Promise<MemberContext> {
  const state = await getMemberSession();
  if (state.kind === "ready") return state.mctx;
  if (state.kind === "anonymous")
    throw new AppError("AUTH_REQUIRED", "Please sign in again.");
  throw new AppError("FORBIDDEN", "Pick your gym first.");
}

/** The signed-in account and its session id (any state), or null. */
export async function getSignedInUser() {
  const h = new Headers(await headers());
  const { auth, db } = services();
  const result = await auth.api.getSession({ headers: h });
  if (!result) return null;
  const user = await db.user.findUnique({ where: { id: result.user.id } });
  if (!user || user.status !== "ACTIVE") return null;
  return {
    sessionId: result.session.id,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
    },
  };
}

/** For member pages: redirects to sign-in or the gym picker, or returns the member context. */
export async function requireMember(
  next = "/m/",
): Promise<Extract<MemberSessionState, { kind: "ready" }>> {
  const state = await getMemberSession();
  if (state.kind === "anonymous")
    redirect(`/m/sign-in?next=${encodeURIComponent(next)}`);
  if (state.kind === "no-gym") redirect("/m/no-gym");
  if (state.kind === "pick-gym") redirect("/m/gyms");
  return state;
}
