/**
 * Creates the first Super Admin (or resets an existing platform user's password).
 * There is no self-signup in the platform realm (D-03); this is the only way in.
 *
 *   pnpm platform:create-admin
 *
 * Reads SEED_ADMIN_EMAIL, SEED_ADMIN_NAME, SEED_ADMIN_PASSWORD from the environment, or asks.
 * Credentials are never stored in code or printed.
 */
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createPrismaClient } from "@gym/db";
import { config as loadDotenv } from "dotenv";
import { upsertPlatformUser } from "../src/platform";

loadDotenv({
  path: path.resolve(import.meta.dirname, "../../../.env"),
  quiet: true,
});

async function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  if (hidden) {
    // Echo nothing while the password is typed.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
      (s: string) => {
        if (s.includes(question)) stdout.write(s);
      };
  }
  const answer = await rl.question(question);
  rl.close();
  if (hidden) stdout.write("\n");
  return answer.trim();
}

const url = process.env.PLATFORM_DATABASE_URL;
if (!url) {
  console.error("PLATFORM_DATABASE_URL is not set.");
  process.exit(1);
}

const email = process.env.SEED_ADMIN_EMAIL || (await ask("Admin email: "));
const name =
  process.env.SEED_ADMIN_NAME ||
  (await ask("Admin name: ")) ||
  "Platform Admin";
const password =
  process.env.SEED_ADMIN_PASSWORD ||
  (await ask("Password (min 12 chars): ", true));

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("That email doesn't look valid.");
  process.exit(1);
}
if (password.length < 12) {
  console.error("The password must be at least 12 characters.");
  process.exit(1);
}

const db = createPrismaClient(url);
try {
  const result = await upsertPlatformUser(db, {
    email,
    name,
    password,
    role: "SUPER_ADMIN",
  });
  console.log(
    `${result.created ? "Created" : "Updated"} Super Admin ${email.toLowerCase()}.`,
  );
  console.log(
    "Sign in at ADMIN_URL; an email code is required on every sign-in.",
  );
} finally {
  await db.$disconnect();
}
