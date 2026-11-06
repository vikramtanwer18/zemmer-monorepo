"use server";

import {
  buyPlanOnline,
  payMyBalance,
  renewMyMembership,
} from "@gym/core/payments";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction } from "@/lib/action";
import { getMemberContext } from "@/lib/member-session";
import { services } from "@/lib/services";

/** Where to send the member back to with an error (only our own member pages). */
function backTo(form: FormData, fallback: string) {
  const v = String(form.get("back") ?? "");
  return /^\/m\/(invoices|plans)?$/.test(v) ? v : fallback;
}

function fail(path: string, message: string): never {
  redirect(
    `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ error: message })}`,
  );
}

/** Sends the member to the checkout page (Razorpay, or the dev test checkout). */
function checkout(link: { shortUrl: string | null }, path: string): never {
  if (!link.shortUrl)
    fail(path, "Couldn't open the payment page. Try again in a minute.");
  redirect(link.shortUrl);
}

export async function payBalanceAction(form: FormData) {
  const path = backTo(form, "/m/invoices");
  const res = await runAction(async () =>
    payMyBalance(services().deps, await getMemberContext(), {
      amount: form.get("amount") ?? "",
    }),
  );
  if (!res.ok) fail(path, res.error.message);
  checkout(res.data, path);
}

export async function renewOnlineAction(form: FormData) {
  const path = backTo(form, "/m/");
  const id = z.uuid().safeParse(form.get("membershipId"));
  if (!id.success) fail(path, "Membership not found.");
  const res = await runAction(async () =>
    renewMyMembership(services().deps, await getMemberContext(), id.data),
  );
  if (!res.ok) fail(path, res.error.message);
  checkout(res.data, path);
}

export async function buyPlanAction(form: FormData) {
  const path = "/m/plans";
  const id = z.uuid().safeParse(form.get("planId"));
  if (!id.success) fail(path, "Plan not found.");
  const res = await runAction(async () =>
    buyPlanOnline(services().deps, await getMemberContext(), id.data),
  );
  if (!res.ok) fail(path, res.error.message);
  checkout(res.data, path);
}
