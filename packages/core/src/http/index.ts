import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { AppError, ERROR_STATUS, isAppError, toActionError } from "../errors";
import type { Logger } from "../logger";
import { parseInput } from "../validation";

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,100}$/;

/** The caller's X-Request-Id when it looks sane, otherwise a new one. */
export function requestIdFrom(headers: Headers): string {
  const given = headers.get("x-request-id");
  return given && REQUEST_ID_RE.test(given) ? given : randomUUID();
}

export type RouteOptions<S extends z.ZodType, C, T> = {
  /** Validates the JSON body (POST/PUT/PATCH/DELETE) or the query string (GET/HEAD). */
  input?: S;
  /** Resolves who is calling (e.g. getAuthContext). Throw AppError to refuse. */
  context: () => Promise<C>;
  handler: (args: {
    input: z.infer<S>;
    ctx: C;
    requestId: string;
    log?: Logger;
  }) => Promise<T>;
  /** Unexpected errors are logged here with the request id. */
  log?: Logger;
  /** HTTP status for success. */
  status?: number;
};

async function readInput(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    return Object.fromEntries(new URL(request.url).searchParams);
  }
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", "The request body must be JSON.");
  }
}

/**
 * The standard route handler: parse with Zod → build context → call the service → map errors.
 * Always answers `{ ok: true, data }` or `{ ok: false, error: { code, message, fields? } }` with
 * the status from ERROR_STATUS, and echoes X-Request-Id. Internal errors never leak details.
 */
export async function handleRoute<S extends z.ZodType, C, T>(
  request: Request,
  options: RouteOptions<S, C, T>,
): Promise<Response> {
  const requestId = requestIdFrom(request.headers);
  const log = options.log?.child({
    requestId,
    method: request.method,
    path: new URL(request.url).pathname,
  });
  const headers = { "x-request-id": requestId, "cache-control": "no-store" };
  try {
    // Who first, then what: an anonymous caller learns nothing about input validation.
    const ctx = await options.context();
    const raw = options.input ? await readInput(request) : undefined;
    const input = options.input
      ? parseInput(options.input, raw)
      : (undefined as z.infer<S>);
    const data = await options.handler({ input, ctx, requestId, log });
    return Response.json(
      { ok: true, data },
      { status: options.status ?? 200, headers },
    );
  } catch (err) {
    const body = toActionError(err);
    if (!isAppError(err)) log?.error({ err }, "route failed");
    return Response.json(body, {
      status: ERROR_STATUS[body.error.code],
      headers,
    });
  }
}
