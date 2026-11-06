import { connection } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  // Never prerender: this must check the database on every request.
  await connection();
  try {
    await getDb().$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", checks: { database: "ok" } });
  } catch {
    return Response.json(
      { status: "error", checks: { database: "down" } },
      { status: 503 },
    );
  }
}
