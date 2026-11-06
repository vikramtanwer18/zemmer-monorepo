import {
  pino,
  type DestinationStream,
  type LevelWithSilent,
  type Logger,
} from "pino";

/** Keys whose values must never be written to logs, at any of the first three nesting levels. */
const SENSITIVE_KEYS = [
  "password",
  "passwordHash",
  "newPassword",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "otp",
  "otpCode",
  "secret",
  "clientSecret",
  "keySecret",
  "webhookSecret",
  "apiKey",
  "cardNumber",
  "cvv",
  "healthNotes",
  "medicalConditions",
  "injuries",
  "medications",
];

const HEADER_PATHS = [
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
];

export const REDACT_PATHS = [
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
  ...HEADER_PATHS,
];

export type { Logger };

export function createLogger(options: {
  name: string;
  level?: LevelWithSilent;
  /** Where to write; defaults to stdout. Tests pass a capture stream. */
  destination?: DestinationStream;
}): Logger {
  return pino(
    {
      name: options.name,
      level: options.level ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    },
    options.destination,
  );
}
