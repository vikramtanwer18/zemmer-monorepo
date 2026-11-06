import type { Metadata } from "next";
import { requireMember } from "@/lib/member-session";
import { MemberCard } from "./member-card";

export const metadata: Metadata = { title: "My card" };

/** The digital membership card. Its data (and the pass secret) comes from /api/m/card. */
export default async function CardPage() {
  const { user } = await requireMember("/m/card");
  return (
    <>
      <h1 className="text-xl font-semibold">My card</h1>
      <MemberCard userId={user.id} />
    </>
  );
}
