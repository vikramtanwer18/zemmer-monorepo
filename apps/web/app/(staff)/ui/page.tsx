import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Showcase } from "./showcase";

export const metadata: Metadata = { title: "Design system" };

/**
 * Every @gym/ui component in each state. Development only; production returns 404 unless
 * UI_SHOWCASE=1 (the e2e accessibility check turns it on).
 */
export default async function UiShowcasePage() {
  await connection();
  if (process.env.NODE_ENV === "production" && process.env.UI_SHOWCASE !== "1")
    notFound();
  return <Showcase />;
}
