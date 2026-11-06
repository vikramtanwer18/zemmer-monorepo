/** Stable error codes and the HTTP status each one maps to. */
export const ERROR_STATUS = {
  AUTH_REQUIRED: 401,
  /** Signed in, but the email OTP second factor is still due. */
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  /** Tenant suspended, cancelled or awaiting approval: reads only. */
  SUBSCRIPTION_INACTIVE: 402,
  ENTITLEMENT_REQUIRED: 402,
  QUOTA_EXCEEDED: 402,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

const GENERIC_MESSAGE = "Something went wrong. Please try again.";

export type FieldErrors = Record<string, string[]>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** Per-field messages for forms (VALIDATION_FAILED). */
  readonly fields?: FieldErrors;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { cause?: unknown; details?: unknown; fields?: FieldErrors },
  ) {
    super(message, { cause: options?.cause });
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options?.details;
    this.fields = options?.fields;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export type ActionError = {
  ok: false;
  error: { code: ErrorCode; message: string; fields?: FieldErrors };
};

export type ActionResult<T> = { ok: true; data: T } | ActionError;

/**
 * Turns any thrown value into a safe result for the browser.
 * Only AppError messages are passed through; anything else becomes a generic INTERNAL error
 * so SQL text and stack traces never leave the server.
 */
export function toActionError(err: unknown): ActionError {
  if (isAppError(err)) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
      },
    };
  }
  return { ok: false, error: { code: "INTERNAL", message: GENERIC_MESSAGE } };
}
