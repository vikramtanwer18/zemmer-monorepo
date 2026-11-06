import { toNextJsHandler } from "better-auth/next-js";
import { services } from "@/lib/services";

// Better Auth endpoints for the tenant realm (sign-in, Google callback, email verification, …).
// The handler is built per request so `next build` never needs the auth secret.
const handler = () => toNextJsHandler(services().auth);

export function GET(request: Request) {
  return handler().GET(request);
}

export function POST(request: Request) {
  return handler().POST(request);
}
