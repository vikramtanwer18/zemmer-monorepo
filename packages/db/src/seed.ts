if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed: NODE_ENV is production.");
  process.exit(1);
}

// Demo data needs password hashing and the core services, so it lives in packages/auth.
console.log("Demo data: run `pnpm db:seed` from the repository root.");
