import { onlinePaymentsEnabled, plansForMe } from "@gym/core/payments";
import {
  Card,
  CardDescription,
  CardTitle,
  EmptyState,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { inr } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";
import { buyPlanAction } from "../pay/actions";

export const metadata: Metadata = { title: "Plans" };

export default async function MemberPlansPage({
  searchParams,
}: PageProps<"/m/plans">) {
  const { mctx } = await requireMember("/m/plans");
  const sp = await searchParams;
  const deps = services().deps;
  const [online, plans] = [
    await onlinePaymentsEnabled(deps, mctx),
    await plansForMe(deps, mctx),
  ];
  return (
    <>
      <h1 className="text-2xl font-semibold">Plans</h1>
      <Flash params={sp} />
      {!online.enabled || plans.length === 0 ? (
        <EmptyState
          title="No plans to buy in the app"
          description="Ask at the front desk about plans and prices."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {plans.map((p) => (
            <li key={p.id}>
              <Card>
                <CardTitle>{p.name}</CardTitle>
                <CardDescription>{p.duration}</CardDescription>
                {p.description && (
                  <p className="mt-2 text-sm">{p.description}</p>
                )}
                <p className="mt-3 text-2xl font-semibold">
                  {inr(p.priceMinor)}
                  {p.joiningFeeMinor > 0 && (
                    <span className="ml-2 text-sm font-normal text-muted">
                      + {inr(p.joiningFeeMinor)} joining fee
                    </span>
                  )}
                </p>
                <form action={buyPlanAction} className="mt-4">
                  <input type="hidden" name="planId" value={p.id} />
                  <SubmitButton className="w-full">
                    Buy and pay online
                  </SubmitButton>
                </form>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">
        Prices are as set by the gym, including GST where it applies. A new plan
        starts today. To extend the plan you have, use Renew on the home screen.
        You'll see the full amount before you pay.
      </p>
    </>
  );
}
