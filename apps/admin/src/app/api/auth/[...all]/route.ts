import { toNextJsHandler } from "better-auth/next-js";
import { services } from "@/lib/services";

// Better Auth endpoints for the platform realm. Built per request so `next build` needs no secret.
const handler = () => toNextJsHandler(services().auth);

export function GET(request: Request) {
  return handler().GET(request);
}

export function POST(request: Request) {
  return handler().POST(request);
}
