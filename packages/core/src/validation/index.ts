import { z } from "zod";
import { AppError, type FieldErrors } from "../errors";

/** Parses external input; throws VALIDATION_FAILED with per-field messages on failure. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields: FieldErrors = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "_";
      (fields[key] ??= []).push(issue.message);
    }
    throw new AppError(
      "VALIDATION_FAILED",
      "Please check the highlighted fields.",
      {
        fields,
      },
    );
  }
  return result.data;
}

/** FormData → plain object. Repeated keys become arrays; empty strings become undefined. */
export function formDataToObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of form.entries()) {
    if (typeof raw !== "string") continue;
    const value = raw === "" ? undefined : raw;
    if (key in out) {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const emailSchema = z
  .email("Enter a valid email address.")
  .max(254)
  .transform((value) => value.trim().toLowerCase());

/** IANA timezone names this runtime knows, e.g. "Asia/Kolkata". */
export const timezoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown timezone.");

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code, e.g. INR.");

export const checkboxSchema = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((value) => value === true || value === "on" || value === "true");
