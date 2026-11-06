import { AuthCard, Button } from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getMemberSession } from "@/lib/member-session";
import { services } from "@/lib/services";
import { memberSignOutAction, selectGymAction } from "../actions";

export const metadata: Metadata = { title: "Choose your gym" };
export const dynamic = "force-dynamic";

export default async function GymPickerPage() {
  const state = await getMemberSession();
  if (state.kind === "anonymous") redirect("/m/sign-in?next=/m/gyms");
  if (state.kind === "no-gym") redirect("/m/no-gym");
  const current = state.kind === "ready" ? state.mctx.tenantId : null;
  return (
    <AuthCard
      brand={services().brand}
      title="Choose your gym"
      description="You're a member at more than one gym."
      footer={
        <form action={memberSignOutAction}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      }
    >
      <ul className="flex flex-col gap-2">
        {state.gyms.map((g) => (
          <li key={g.tenantId}>
            <form action={selectGymAction}>
              <input type="hidden" name="tenantId" value={g.tenantId} />
              <Button
                type="submit"
                variant={g.tenantId === current ? "primary" : "outline"}
                className="w-full justify-between"
              >
                {g.displayName}
                {g.tenantId === current && (
                  <span className="text-xs">Current</span>
                )}
              </Button>
            </form>
          </li>
        ))}
      </ul>
    </AuthCard>
  );
}
