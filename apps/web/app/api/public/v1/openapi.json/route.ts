import { publicApiDocument } from "@gym/core/crm";
import { services } from "@/lib/services";

/** OpenAPI document for the public API (no secrets; public). */
export function GET() {
  return Response.json(publicApiDocument(services().deps.appUrl ?? ""), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
