# Gym SaaS — Developer Setup Guide (Turborepo)

Oct 30, 2026 · @Team Fonixtech

Start from the official Turborepo starter, reshape it into our three apps, then add one piece of infrastructure at a time: the database, then Redis, then the rest. Each phase lists the commands to run, the files to create and what goes in them, and how to check it worked before you move on.

## Where you end up

The finished repo has three apps and six shared packages. The starter gives you three of them; you add the rest phase by phase.

| Folder | What it is | Comes from |
| --- | --- | --- |
| `apps/web` | Gym staff dashboard at `/`, member PWA at `/m` (port 3000) | Starter, reshaped in Phases 3, 10, 11 |
| `apps/admin` | Platform operator console (port 3001) | You create it in Phase 4 |
| `apps/worker` | Background job runner, no UI (health on port 4100) | You create it in Phase 5 |
| `packages/ui` | Shared React components and brand tokens | Starter, replaced in Phase 10 |
| `packages/eslint-config` | Shared lint rules | Starter, kept |
| `packages/typescript-config` | Shared TypeScript settings | Starter, one fix in Phase 3 |
| `packages/env` | Validated environment variables | Phase 6 |
| `packages/core` | Business logic: errors, logging, money, time, jobs | Phases 7 and 9 |
| `packages/db` | Prisma schema, migrations, database client | Phase 8 |
| `packages/testing` | Throwaway test databases | Phase 8 |
| `apps/docs` | Starter demo app | Deleted in Phase 3 |

## Phase 1 — Prerequisites

**Goal:** have the tools installed once, at versions the rest of the guide expects.

1. Install **Node.js 24 LTS** (`node -v` shows v24.x). On Windows, work inside WSL2 Ubuntu for the whole project.
2. Install **pnpm**: `npm install -g pnpm`. The starter pins its own pnpm version and pnpm switches to it automatically.
3. Install **Docker Desktop** (or Docker Engine with Compose v2). `docker compose version` should print v2.x.
4. Install **Git**, and in VS Code the ESLint, Prettier, Prisma and Tailwind CSS IntelliSense extensions.

**Check:** `node -v`, `pnpm -v` and `docker compose version` all print a version.

## Phase 2 — Create the monorepo with create-turbo

**Goal:** a working Turborepo with pnpm workspaces, created by the official starter.

1. From the folder where you keep projects, run:

```bash
npx create-turbo@latest gym-saas --package-manager pnpm
```

It creates the folder, installs dependencies and makes the first Git commit.

2. Open the folder and look at what you got:

| Path | What it is |
| --- | --- |
| `apps/web` | A Next.js app on port 3000 |
| `apps/docs` | A second Next.js demo app on port 3001 |
| `packages/ui` | Shared React components (`@repo/ui`) |
| `packages/eslint-config` | Shared ESLint configs: `base`, `next-js`, `react-internal` |
| `packages/typescript-config` | Shared tsconfigs: `base.json`, `nextjs.json`, `react-library.json` |
| `turbo.json` | Task pipeline: `build`, `dev`, `lint`, `check-types` |
| `pnpm-workspace.yaml` | Tells pnpm that `apps/*` and `packages/*` are packages |

3. Run it once as it comes:

```bash
cd gym-saas
pnpm dev
```

**Understand it:** every package is a folder with its own `package.json`. A package uses another by listing it as a dependency with the version `workspace:*`, which is how `apps/web` uses `@repo/ui`. `turbo` runs the same-named script (`dev`, `build` and so on) in every package that has one, in dependency order, and caches results.

**Check:** http://localhost:3000 and http://localhost:3001 both show the starter page. Stop it with Ctrl+C.

## Phase 3 — Clean up the starter

**Goal:** remove the demo parts and fix the one starter setting that breaks later phases.

1. **Delete the docs app.** Remove the `apps/docs` folder. We replace it with our own admin app in Phase 4.
2. **Rename the package scope from `@repo` to `@gym`.** In VS Code, search the whole project for `@repo/` (exclude `node_modules`) and replace every hit with `@gym/`. Hits appear in each `package.json`, in `tsconfig.json` files, in `eslint.config.js` files and in imports inside `apps/web`. Then run `pnpm install` so pnpm relinks the packages under their new names.
3. **Fix module resolution.** Open `packages/typescript-config/base.json`. Change `module` to `ESNext` and `moduleResolution` to `Bundler`. The starter uses `NodeNext`, which forces every relative import to end in `.js`. Prisma's generated client and our packages import without extensions, so `NodeNext` produces "Relative import paths need explicit file extensions" errors in Phase 8.
4. **Empty the demo page.** In `apps/web/app`:
   - Replace the contents of `page.tsx` with a single heading such as "Gym Dashboard".
   - Delete `page.module.css`.
   - Delete the starter images in `apps/web/public`.
5. **Tidy the root.**
   - In the root `package.json`, set `name` to `gym-saas`.
   - Add a `.nvmrc` file containing `24`.
   - In `.gitignore`, add `generated` (Prisma output) and `!.env.example`, so the example env file can be committed while `.env` stays ignored.
6. **Commit:** `git add -A && git commit -m "chore: reshape starter"`.

**Understand it:** renaming the scope now is cheap; renaming after 20 packages import each other is not. `Bundler` resolution matches how Next.js, Vitest, tsx and esbuild actually load files, so TypeScript and the tools agree.

**Check:** `pnpm check-types` and `pnpm build` both finish with "Tasks: N successful".

## Phase 4 — Add the admin app

**Goal:** a second Next.js app for the platform operator, wired to the same shared configs as `web`.

1. Generate it inside `apps`:

```bash
cd apps
pnpm create next-app@latest admin --ts --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --use-pnpm --skip-install --disable-git
cd ..
```

2. **Delete what conflicts with the monorepo:** `apps/admin/pnpm-workspace.yaml` (only the root one may exist) and `apps/admin/README.md`. Leave `AGENTS.md`; Next.js recreates it anyway.
3. **Make `package.json` match web's.** Open `apps/web/package.json` next to `apps/admin/package.json` and copy the pattern:
   - Remove the `packageManager` field; only the root declares it.
   - Add `"type": "module"`.
   - Scripts: `dev` and `start` run on `--port 3001`. Add `check-types` with the same command web uses. Make `lint` the same as web's.
   - Add dependencies `@gym/ui`, `@gym/eslint-config` and `@gym/typescript-config` with version `workspace:*`.
   - Set `typescript`, `eslint` and the `@types/*` packages to the same versions web uses.
4. **ESLint:** delete `eslint.config.mjs` and copy `apps/web/eslint.config.js` into `apps/admin`. It is one import of the shared `next-js` config.
5. **TypeScript:** in `apps/admin/tsconfig.json`, extend `@gym/typescript-config/nextjs.json` instead of listing every option. Keep the `@/*` path alias pointing to `./src/*`. In `include`, keep both `.next/types/**/*.ts` and `.next/dev/types/**/*.ts`; without the second one, type checking fails with "Cannot find name 'LayoutProps'".
6. **Align Next.js versions.** `create-next-app@latest` may install a newer Next.js than the starter's web app. Check `next` in both `package.json` files and bring web up to the same version: `pnpm --filter web add next@<version> react@<version> react-dom@<version>`.
7. Run `pnpm install` from the root.

**Understand it:** admin is a separate app, not a folder inside web, because it gets its own login, its own database role and its own domain. A bug in the gym app can never expose platform controls.

**Check:** `pnpm dev` serves web on http://localhost:3000 and admin on http://localhost:3001. `pnpm check-types` passes for both. (`pnpm build` downloads the Geist font from Google; it needs internet the first time.)

## Phase 5 — Add the worker app

**Goal:** a plain Node.js process that will run background jobs. It has no UI and no framework, so you create it by hand.

1. Create the folder and its `package.json`:

```bash
mkdir -p apps/worker/src
cd apps/worker
pnpm init
pnpm add -D tsx typescript @types/node "@gym/typescript-config@workspace:*" "@gym/eslint-config@workspace:*" eslint
cd ../..
```

Use the same `typescript` and `eslint` versions as web.

2. **Edit `apps/worker/package.json`:** name it `worker`, set `"private": true` and `"type": "module"`. Add these scripts:
   - `dev`: `tsx watch src/index.ts`. Runs TypeScript directly and restarts on every save.
   - `check-types`: `tsc --noEmit`
   - `lint`: the same as `packages/ui` uses
   - `build` and `start` come in Phase 15.
3. **Create `apps/worker/tsconfig.json`:** extend `@gym/typescript-config/base.json`, set `noEmit` to true, and include `src`.
4. **Create `apps/worker/eslint.config.js`:** export the `config` array from `@gym/eslint-config/base`.
5. **Create `apps/worker/src/index.ts`** for now with two jobs only:
   - log "worker started" on start;
   - listen for `SIGTERM` and `SIGINT`, log "shutting down", and exit.

   The real queue processing arrives in Phase 9.
6. Run `pnpm install` from the root.

**Understand it:** jobs like reminders and payment reconciliation must not depend on a browser request staying open. The worker is a separate long-running process so a deploy can restart the web app instantly while the worker finishes its current jobs first.

**Check:** `pnpm dev` now starts three tasks, and the worker prints "worker started". Ctrl+C makes it print "shutting down".

## Phase 6 — Environment variables and the env package

**Goal:** one `.env` file at the root, read by every app, and validated at startup so a missing or mistyped value fails immediately with a clear message.

1. **Create the root env files.**
   - `.env.example` is committed and holds placeholders plus every variable the project needs.
   - `.env` is your local copy and is never committed.
   - Start with `NODE_ENV`, `LOG_LEVEL`, `APP_URL` (http://localhost:3000) and `ADMIN_URL` (http://localhost:3001). Each later phase adds its own variables to both files.
2. **Create `packages/env`** (name `@gym/env`, `private`, `type: module`, exports `./src/index.ts`):

```bash
mkdir -p packages/env/src && cd packages/env
pnpm init
pnpm add zod
pnpm add -D typescript @types/node "@gym/typescript-config@workspace:*"
cd ../..
```

3. **In `packages/env/src/index.ts`, define with Zod:**
   - a shared schema (`NODE_ENV` as an enum with a default, `LOG_LEVEL`);
   - one schema per concern (database URLs, Redis, storage, email), added in the phases that need them;
   - one combined schema per app (`webEnvSchema`, `adminEnvSchema`, `workerEnvSchema`) built by extending the shared one;
   - a `loadEnv(schema)` function that validates `process.env` and, on failure, throws one error that lists every problem, not just the first.
4. **Make each app read the root `.env`.** Next.js only reads `.env` from its own folder, so:
   - In each Next app, rename `next.config.js` to `next.config.ts` (web) and load the root `.env` at the top with `dotenv`, using a path two folders up. Add `dotenv` and `@gym/env` to the app.
   - In each Next app, add `src/env.ts` (web uses `env.ts` at the app root if it has no `src`) with a `getEnv()` function that validates on first call and caches the result. Mark the file `import "server-only"` so it can never reach the browser.
   - Add `instrumentation.ts` with a `register()` function that calls `getEnv()` when `NEXT_RUNTIME` is `nodejs`. That runs when the server starts, so a bad config stops the server at once. Validation stays lazy so `next build` works without secrets (Phase 15).
   - In the worker, add `src/env.ts` that loads the root `.env` with `dotenv` and validates with `workerEnvSchema`.
5. **Tell Turborepo about env vars.** In `turbo.json`, add `.env` to `globalDependencies` (cache resets when it changes). List every variable your code reads in `globalEnv`. The starter's ESLint rule `turbo/no-undeclared-env-vars` warns about any variable missing from that list, and `lint` treats warnings as errors.

**Understand it:** one schema per app means each app only demands what it uses. The admin app never needs the gym database URL, so it is not in its schema.

**Check:** temporarily delete `APP_URL` from `.env` and run `pnpm --filter web dev`. The server stops with "Invalid environment configuration" naming `APP_URL`. Put it back.

## Phase 7 — Core package: errors, logging, money, time

**Goal:** the home for all business logic, starting with the four building blocks every later feature uses.

1. Create the package:

```bash
mkdir -p packages/core/src && cd packages/core
pnpm init
pnpm add pino zod
pnpm add -D typescript @types/node vitest "@gym/typescript-config@workspace:*" "@gym/eslint-config@workspace:*" eslint
cd ../..
```

2. In `package.json`: name `@gym/core`, `type: module`, scripts `check-types`, `lint` and `test` (`vitest run`). Use one export per area (`./errors`, `./logger`, `./money`, `./time`), so an app imports only what it needs, e.g. `@gym/core/money`. Add `tsconfig.json` and `eslint.config.js` as in the worker.
3. **`src/errors`:**
   - An `AppError` class carrying a stable `code` (AUTH\_REQUIRED, FORBIDDEN, NOT\_FOUND, VALIDATION\_FAILED, CONFLICT, ENTITLEMENT\_REQUIRED, QUOTA\_EXCEEDED, RATE\_LIMITED, PROVIDER\_ERROR, INTERNAL) and the HTTP status that code maps to, in one table.
   - A `toActionError(err)` function that turns any thrown value into `{ ok: false, error: { code, message } }`. Unknown errors become INTERNAL with a generic message, so SQL text and stack traces never reach the browser.
4. **`src/logger`:** a `createLogger({ name, level })` that returns a pino JSON logger. It has a redaction list (password, token, otp, secret, apiKey, authorization header, cookie, card number, health fields) applied before anything is written.
5. **`src/money`:**
   - Money is `{ amountMinor, currency }`, where `amountMinor` is an integer number of paise. Never use floats.
   - Functions: `money()` (rejects non-integers), `add`/`subtract` (reject mixed currencies), `percentOf(amount, basisPoints)` where 18% GST = 1800, `splitInclusive(gross, basisPoints)` for tax-inclusive prices, and `formatMoney()` using the `en-IN` locale.
   - Do the rounding with `BigInt` and half-up rounding, so large amounts stay exact.
6. **`src/time`:** `localDate(instant, timeZone)` returns the calendar day as the gym sees it. `indianFinancialYear(instant)` returns a label like "2026-27" that flips at midnight IST on 1 April. Invoice numbering in M2 depends on it.
7. **Tests** sit next to each file (`money.test.ts` and so on). Cover:
   - 18% of ₹1,000 is exactly ₹180;
   - half a paisa rounds up;
   - a tax-inclusive split adds back up exactly;
   - mixing INR and USD throws;
   - 20:00 UTC on 31 March is already 1 April in India;
   - unknown errors never expose their message;
   - passwords and OTPs never appear in log output.
8. Add a `test` task to `turbo.json`.

**Understand it:** putting these here first means every module built later (billing, invoices, attendance) handles money, time zones and errors the same safe way.

**Check:** `pnpm test` runs the core tests and all pass.

## Phase 8 — PostgreSQL and the database package

**Goal:** Postgres running locally, a `@gym/db` package that owns the schema and migrations, both Next apps connected to it, and proof that one gym can never read another gym's rows.

### 8.1 Run Postgres in Docker

1. **Create `docker-compose.yml` at the root** with one service for now, `postgres`:
   - image `postgres:18-alpine`;
   - environment `POSTGRES_USER=gym_owner`, a password, and `POSTGRES_DB=gym`;
   - port 5432;
   - a named volume mounted at `/var/lib/postgresql` (Postgres 18 stores data in a versioned folder under it);
   - a health check using `pg_isready`;
   - the folder `./infra/postgres` mounted read-only at `/docker-entrypoint-initdb.d`.
2. **Create `infra/postgres/01-roles.sql`.** Postgres runs it once, when the volume is first created. It creates two login roles, `gym_app` and `gym_platform`, both `NOSUPERUSER` and `NOBYPASSRLS`, and grants them `CONNECT` on the `gym` database.
3. **Add root scripts:** `services:up` runs `docker compose up -d --wait` and `services:down` runs `docker compose down`.
4. Run `pnpm services:up`.

The three roles are the heart of the isolation design:

| Role | Used by | Can do |
| --- | --- | --- |
| `gym_owner` | Migrations and seeds only | Everything; owns the tables |
| `gym_app` | web + worker at runtime | Read and write the `app` schema, always filtered by row-level security |
| `gym_platform` | admin at runtime | Read and write the `platform` schema; no access to gym data |

### 8.2 Environment variables

Add three URLs to `.env.example` and `.env`, all pointing at `localhost:5432/gym` with each role's own user and password:

- `MIGRATION_DATABASE_URL` as `gym_owner`
- `DATABASE_URL` as `gym_app`
- `PLATFORM_DATABASE_URL` as `gym_platform`

In `@gym/env`, add `DATABASE_URL` to the web and worker schemas and `PLATFORM_DATABASE_URL` to the admin schema.

### 8.3 Create the database package

```bash
mkdir -p packages/db/prisma packages/db/src && cd packages/db
pnpm init
pnpm add @prisma/client@7.10.1 @prisma/adapter-pg@7.10.1 pg
pnpm add -D prisma@7.10.1 @types/pg dotenv tsx typescript vitest "@gym/typescript-config@workspace:*"
cd ../..
```

Pin Prisma to 7.10.1: npm's `latest` tag currently points at an 8.0 release candidate. pnpm then refuses to run Prisma's install scripts. Open `pnpm-workspace.yaml`: pnpm has added an `allowBuilds:` section with `set this to true or false` next to `@prisma/engines` and `prisma`. Change both to `true` and run `pnpm install` again.

1. **`package.json`:** name `@gym/db`, export `./src/index.ts`. Scripts:
   - `db:generate` → `prisma generate`
   - `db:migrate` → `prisma migrate dev`
   - `db:deploy` → `prisma migrate deploy`
   - `db:seed` → runs `src/seed.ts` with tsx
   - `check-types`
   - `test:int` → Vitest with its own integration config

   Add root scripts `db:migrate`, `db:deploy` and `db:seed` that call these with `pnpm --filter @gym/db`.
2. **`prisma.config.ts`** (Prisma 7 keeps settings here, not in the schema): load the root `.env` with `dotenv`; point at the schema file and the migrations folder; set the seed command. Set the datasource URL from `MIGRATION_DATABASE_URL` only when that variable exists, because `prisma generate` must work in Docker builds where it is absent.
3. **`prisma/schema.prisma`:**
   - a generator using provider `prisma-client` with output `../generated/prisma`;
   - a `postgresql` datasource with `schemas = ["platform", "app"]`;
   - one placeholder model, `HealthCheck`, in the `platform` schema, so the first migration has something to create. Real models start in M1.
4. **`src/client.ts`:**
   - `createPrismaClient(url)` builds a `PrismaClient` with the `PrismaPg` adapter for one connection string.
   - `getPrismaClient(url)` caches clients on `globalThis`, so Next.js dev reloads do not open a new connection pool each time.
5. **`src/seed.ts`:** prints "nothing to seed yet" and refuses to run when `NODE_ENV` is production.
6. Create the first migration: `pnpm db:migrate --name init`.

### 8.4 Grants and the tenant helper

1. Create an empty migration: `pnpm --filter @gym/db exec prisma migrate dev --create-only --name db_roles_and_rls_helpers`. Open the new `migration.sql` and write SQL that:
   - grants `gym_app` usage on schema `app` and SELECT/INSERT/UPDATE/DELETE on its tables and sequences;
   - grants `gym_platform` the same on schema `platform`;
   - adds `ALTER DEFAULT PRIVILEGES FOR ROLE gym_owner` for both, so tables from future migrations get the same grants automatically;
   - revokes everything on schema `app` from `gym_platform`;
   - creates the function `app.current_tenant_id()`. It returns `current_setting('app.tenant_id', true)` as a uuid, or NULL when empty. NULL matches no rows, so a forgotten tenant id shows nothing instead of everything. Grant `gym_app` execute on it.
2. Apply it with `pnpm db:migrate`.
3. **`src/tenant.ts`:** `withTenant(db, tenantId, fn)`. It checks that the id is a UUID, opens a Prisma transaction, runs `set_config('app.tenant_id', tenantId, true)` inside it (the `true` keeps the value local to that transaction), then runs `fn` with the transaction client.
4. **`src/index.ts`** exports both helpers and the generated client types.

### 8.5 Wire it into Turborepo and the apps

1. **`turbo.json`:** add a `db:generate` task with `cache: false`. Make `build`, `dev`, `check-types`, `lint` and `test` depend on both `^db:generate` and `db:generate`, so the Prisma client always exists before anything imports it.
2. **`.gitignore`:** ignore `packages/db/generated`.
3. **Both Next apps:**
   - add `@gym/db` and list it in `transpilePackages` in `next.config.ts`;
   - add `lib/db.ts` with a `getDb()` function marked `server-only`; web uses `DATABASE_URL`, admin uses `PLATFORM_DATABASE_URL`;
   - add a route `app/api/health/route.ts` whose GET handler calls `connection()` (so it is never prerendered), runs `SELECT 1`, and returns 200 with `status: ok`, or 503 if the database is unreachable.

### 8.6 Prove tenant isolation

1. **Create `packages/testing`** (`@gym/testing`, dependency `pg`) with `createTestDatabase()`. It:
   - creates a uniquely named database such as `gym_test_1a2b3c4d`;
   - grants both runtime roles CONNECT;
   - runs every `migration.sql` in order;
   - returns a URL for each role plus a `drop()` function.

   Each test file gets its own empty database, and your dev data is never touched.
2. **Add `packages/db/vitest.int.config.ts`.** It loads the root `.env` and includes `test/**/*.int.test.ts`.
3. **Write `test/rls.int.test.ts`.** As the owner, it creates a probe table `app.rls_probe` with a `tenant_id` column. It enables and forces row-level security and adds a policy whose USING and WITH CHECK both compare `tenant_id` with `app.current_tenant_id()`. Then, connecting as `gym_app`, it proves:
   - [ ] gym A can insert and read its own row;
   - [ ] gym B sees zero rows, with no WHERE clause;
   - [ ] with no tenant set, a query returns nothing;
   - [ ] gym A cannot insert a row tagged as gym B;
   - [ ] the tenant id does not leak into the next query on the same connection;
   - [ ] `gym_platform` gets "permission denied" on the probe table;
   - [ ] a non-UUID tenant id is rejected before any SQL runs.
4. Add a `test:int` task to `turbo.json` with `cache: false`, and a root script that runs it with `--concurrency=1`.

**Understand it:** from M1 on, every gym-owned table copies the probe table's policy. Code bugs that forget a `WHERE tenant_id = …` still cannot leak data, because Postgres applies the filter itself.

**Check:**

- `pnpm test:int` shows 7 passing tests.
- `pnpm dev`, then http://localhost:3000/api/health and http://localhost:3001/api/health both return `"status":"ok"`.
- `docker compose stop postgres` makes them return 503; `docker compose start postgres` brings them back.

## Phase 9 — Redis and background jobs

**Goal:** Redis running locally, a typed job catalogue in `@gym/core`, the worker processing jobs, and the web app able to add them.

### 9.1 Run Redis in Docker

1. Add a `redis` service to `docker-compose.yml`:
   - image `redis:8-alpine`;
   - command `redis-server --appendonly yes`, so queued jobs survive a restart;
   - port 6379, a named volume at `/data`, and a health check running `redis-cli ping`.
2. Run `pnpm services:up` again; Compose adds only the new service.
3. Add `REDIS_URL=redis://localhost:6379` to `.env.example` and `.env`, add it to all three app schemas in `@gym/env`, and list it in `turbo.json` `globalEnv`.

### 9.2 Job catalogue in the core package

```bash
pnpm --filter @gym/core add bullmq ioredis
```

pnpm stops on the optional native add-on `msgpackr-extract`. Set it to `false` under `allowBuilds:` in `pnpm-workspace.yaml` and run `pnpm install` again.

Create `packages/core/src/jobs` and add `./jobs` to the package's exports.

1. **The envelope.** A Zod schema that wraps every job's data with:
   - `tenantId`: a UUID, or null for platform-wide jobs;
   - `actor`: user or system, plus an optional id;
   - `idempotencyKey`: a string with no `:` and not just digits, because BullMQ uses it as the job id and rejects both.
2. **The catalogue.** A `JOBS` object mapping queue name → job name → data schema. Start with queue `system` and job `system.ping` carrying a short `message`. Derive TypeScript types from it, so the producer and the worker can never disagree about a payload.
3. **`parseJob(queue, name, payload)`** validates a payload against the catalogue. It runs when a job is added and again when it is processed.
4. **Queue helpers:**
   - `createRedisConnection(url)` returns an ioredis client with `maxRetriesPerRequest: null`, which BullMQ workers require.
   - Default job options: 5 attempts, exponential backoff starting at 2 seconds, completed jobs kept for a day, and failed jobs never removed automatically.
   - `getQueue(name, connection)` caches one Queue per name.
   - `enqueue(connection, queue, name, envelope)` validates, then adds with `jobId` = the idempotency key. Adding the same key twice creates one job.
   - `closeQueues()` closes all queues.

### 9.3 Process jobs in the worker

Add `@gym/core`, `@gym/db`, `@gym/env`, `bullmq`, `ioredis` and `dotenv` to the worker. Then:

1. **`src/context.ts`:** `buildContext(queue, job, db, log)` validates the job, creates a child logger tagged with the job id and tenant id, and offers `tenantDb(fn)`. That function runs database work through `withTenant` for the job's tenant and refuses if the job has none.
2. **`src/processors/`:** one file per job. `system.ping` logs "pong" with the message and returns it. An index file maps queue → job name → handler and sets concurrency per queue.
3. **`src/worker.ts`:** `startWorkers(connection, db, log)` starts one BullMQ `Worker` per queue. A job with no handler fails loudly. It logs every failed job with its attempt number.
4. **`src/index.ts`** (replace the Phase 5 version):
   - create the logger, the Redis connection, the Prisma client (`DATABASE_URL`) and the workers;
   - start a small HTTP server on `WORKER_HEALTH_PORT` (default 4100) whose `/health` returns 200 only when Redis answers PING and Postgres answers `SELECT 1`;
   - on SIGTERM or SIGINT: close the health server, close the workers (this waits for running jobs to finish), quit Redis, disconnect Prisma, then exit.

### 9.4 Add jobs from the web app

1. Add `lib/queue.ts` with `getRedis()`: one Redis connection per server process, cached on `globalThis`, marked `server-only`.
2. Add a development-only route `app/api/dev/ping/route.ts`. Its POST handler enqueues `system.ping` with a random idempotency key and returns the job id. It returns 404 when `NODE_ENV` is production.

### 9.5 Test the queue

Add `apps/worker/vitest.int.config.ts` and `test/queue.int.test.ts`. Point the test at Redis logical database 15 (`redis://localhost:6379/15`) so your dev queues are untouched, and use `createTestDatabase()` for Postgres. Prove:

- [ ] a ping job goes from producer to worker and returns "pong";
- [ ] the same idempotency key added twice gives exactly one completed job;
- [ ] an invalid payload is rejected before reaching Redis;
- [ ] `tenantDb()` inside a job sees exactly that job's tenant id.

**Understand it:** the worker never trusts a payload. It re-validates every job and re-establishes the tenant context itself. A job queued months ago, or crafted by hand in Redis, still cannot touch another gym's data.

**Check:**

- `pnpm dev`, then http://localhost:4100/health returns `"status":"ok"`.
- `curl -X POST localhost:3000/api/dev/ping` makes the worker log "pong".
- Ctrl+C makes the worker log "shutting down" then "bye".
- `pnpm test:int` now runs 11 tests.

## Phase 10 — Styling and the design system

**Goal:** Tailwind CSS in both apps, brand colours defined once in `@gym/ui`, and the starter's demo components replaced by our own.

### 10.1 Tailwind in both apps

Admin already has Tailwind from `--tailwind` in Phase 4. Give web the same setup, copying from admin:

1. `pnpm --filter web add -D tailwindcss @tailwindcss/turbopack`.
2. Copy the `turbopack.rules` entry for `*.css` from `apps/admin/next.config.ts` into web's `next.config.ts`.
3. Replace web's `globals.css` with a single `@import "tailwindcss";` line, as admin has.
4. In both apps' `next.config.ts`, add `@gym/ui` to `transpilePackages`.

### 10.2 Rebuild the UI package

1. Delete the starter components in `packages/ui/src` (`button.tsx`, `card.tsx`, `code.tsx`) and remove their imports from web.
2. `pnpm --filter @gym/ui add clsx tailwind-merge lucide-react`.
3. **`src/theme.css`:** inside a Tailwind v4 `@theme { }` block, declare each brand colour as a `--color-*` variable. Tailwind turns each one into utilities automatically, so `--color-primary` gives `bg-primary` and `text-primary`. Also add a small `@layer base` for the body background, text colour and a visible focus outline.

| Token | Value | Use |
| --- | --- | --- |
| `primary` | #204289 | Main buttons, headers; white text on it is 9.5:1 |
| `secondary` | #394E85 | Secondary buttons; white text 8.1:1 |
| `accent` | #00A89D | Fills and icons only: as text on white it is 3.0:1, which fails WCAG AA |
| `accent-foreground` | #0B1B33 | Text on accent buttons (5.8:1). White on accent fails. |
| `accent-strong` | #007A72 | Accent-coloured text and links (5.2:1) |
| `background` / `surface` | #F7F7F7 / #FFFFFF | Page and card backgrounds |
| `foreground` / `muted` | #0B1B33 / #5B6475 | Body text / secondary text (5.6:1) |
| `success` / `warning` / `danger` / `info` | #15803D / #B45309 / #B91C1C / #1D4ED8 | Status colours, each with a light "soft" background variant |

4. **`src/cn.ts`:** a `cn(...classes)` helper that combines `clsx` with `tailwind-merge`, so a later class overrides an earlier conflicting one.
5. **First components:**
   - `Button`: variants primary, secondary, accent, outline, ghost, danger; sizes sm, md, lg; a `loading` prop that shows a spinner, disables the button and sets `aria-busy`.
   - `Card`, `CardTitle`, `CardDescription`.
   - `Badge`: tones neutral, success, warning, danger, info.
   - `FormField`: label + input + hint or error, linked by ids through `aria-describedby`, so screen readers read the error.
6. **Exports:** change `package.json` so `.` points to `src/index.ts` (which re-exports everything) and `./theme.css` points to the stylesheet.
7. **In both apps' `globals.css`:** after the Tailwind import, import `@gym/ui/theme.css` and add an `@source` line pointing at `packages/ui/src`. Tailwind only generates classes it finds in scanned files, and the UI package lives outside the app folder.
8. **Component test:** add Vitest with the `jsdom` environment, `@testing-library/react` and `@testing-library/jest-dom`. Test that a Button calls `onClick`, and that a loading Button is disabled, has `aria-busy`, and ignores clicks.

**Understand it:** M0 lists about 25 components in total (Dialog, DataTable, Toast, AppShell and others). Build them the same way, each with keyboard support and loading, empty and error states.

**Check:** the web page shows navy, white and teal buttons with readable text, and `pnpm test` includes the UI tests.

## Phase 11 — Member app as a PWA

**Goal:** inside the web app, separate the staff dashboard (`/`) from the member app (`/m`), and make the member app installable on phones with an offline page.

1. **Split web into two route groups.** In `apps/web/app`, create `(staff)` and `(member)` folders. Folder names in brackets do not appear in URLs.
   - Move `page.tsx` into `(staff)`. Give `(staff)` its own `layout.tsx` with the `<html>` tag and the stylesheet import.
   - Delete the top-level `app/layout.tsx`. Each group now has its own root layout.
   - In `(member)`, create `layout.tsx` and a folder `m` containing `page.tsx` (the member home) and `offline/page.tsx` (a short "You are offline" message).
2. **Manifest.** Create `public/m/manifest.webmanifest` with:
   - name and short name "My Gym";
   - `id`, `start_url` and `scope` all `/m/`, so the staff dashboard is never part of the installed app;
   - `display: standalone`, portrait orientation, background `#F7F7F7`, theme colour `#204289`;
   - three icons.
3. **Icons.** Make three PNGs from your logo in `public/m`: 192×192, 512×512, and a 512×512 "maskable" one with the logo inside the central 80%.
4. **Service worker.** Create `public/m/sw.js` with a `VERSION` constant. It does three things:
   - on install, caches the `/m/offline` page;
   - on activate, deletes caches from older versions;
   - on fetch, for page navigations only, tries the network and falls back to the cached offline page.
5. **Register it.** Add a small client component (`"use client"`) that registers `/m/sw.js` with scope `/m/` in a `useEffect`. Render it in the member layout.
6. **Member layout metadata.** Point `manifest` at `/m/manifest.webmanifest`, set `appleWebApp` for iOS, and set the viewport theme colour.
7. **Headers.** In web's `next.config.ts`, add a `headers()` function:
   - for every route: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`;
   - for `/m/sw.js`: `Cache-Control: no-cache, no-store, must-revalidate` and `Service-Worker-Allowed: /m/`.

**Understand it:** if browsers cached `sw.js`, a fix would never reach members' phones; that is what the no-cache header prevents. Bump `VERSION` whenever you change the file. Service workers only run on localhost or HTTPS, so test on a real phone through a staging URL, not your laptop's IP. In M3 the same worker caches the membership card so check-in works offline.

**Check:** open http://localhost:3000/m in Chrome, then DevTools → Application:

- Manifest shows no errors;
- Service workers shows `/m/sw.js` activated;
- the address bar offers Install;
- with Offline ticked in the Network tab, any `/m/...` page shows the offline message.

## Phase 12 — File storage and email (MinIO, Mailpit)

**Goal:** local stand-ins for AWS S3 and SES, ready for member photos, documents and emails in M1.

### 12.1 File storage with MinIO

1. Add a `minio` service to `docker-compose.yml`:
   - image `minio/minio`, command `server /data --console-address :9001`;
   - a root user and password;
   - ports 9000 (API) and 9001 (web console), a named volume, and a health check using `mc ready local`.
2. Add a one-shot `minio-init` service:
   - image `minio/mc`, starting once `minio` is healthy;
   - it sets an alias and creates the bucket `gym-dev-uploads`;
   - `restart: "no"`.
3. Add `S3_ENDPOINT` (http://localhost:9000), `S3_REGION` (ap-south-1), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_FORCE_PATH_STYLE=true` to the env files, and a storage schema in `@gym/env`. On AWS you drop `S3_ENDPOINT` and use the real region and bucket.

### 12.2 Email with Mailpit

1. Add a `mailpit` service: image `axllent/mailpit`, ports 1025 (SMTP) and 8025 (inbox in the browser), and a health check using `/mailpit readyz`.
2. Add `SMTP_HOST` (localhost), `SMTP_PORT` (1025) and `EMAIL_FROM` to the env files, and an email schema in `@gym/env`.

**Understand it:** Mailpit catches every email the app sends, so testing invites or OTP codes never reaches a real inbox. The code that uploads files and sends mail is written in M1 against these same variables, and switching to S3 and SES later only changes the variable values.

**Check:** after `pnpm services:up`, `docker compose ps` shows four healthy services. http://localhost:9001 opens the MinIO console with the `gym-dev-uploads` bucket, and http://localhost:8025 opens an empty Mailpit inbox.

## Phase 13 — Tests

**Goal:** three kinds of automated test, each run with one command, so every later milestone can change code safely.

| Kind | Tool | Needs Docker services? | Command | Written in |
| --- | --- | --- | --- | --- |
| Unit: pure logic and components | Vitest | No | `pnpm test` | Phases 7, 10 |
| Integration: real Postgres and Redis | Vitest + `@gym/testing` | Yes | `pnpm test:int` | Phases 8, 9 |
| End-to-end: a real browser on the built apps | Playwright | Yes | `pnpm test:e2e` | This phase |

1. **Install Playwright** in both Next apps and download the browser once per machine:

```bash
pnpm --filter web --filter admin add -D @playwright/test
pnpm --filter web exec playwright install chromium
```

2. **Add `playwright.config.ts` to each app:**
   - test folder `e2e`; base URL `http://localhost:3000` (admin: 3001);
   - in CI: retries, the GitHub reporter, and `forbidOnly`;
   - a desktop Chrome project, and in web also a mobile (Pixel 7) project;
   - a `webServer` entry that runs `pnpm start`, waits for `/api/health`, and reuses a server you already have running locally.
3. **Write `e2e/smoke.spec.ts`:**
   - web: the dashboard heading is visible; `/api/health` returns ok; `/m` links the manifest, the manifest's scope is `/m/`, and `sw.js` is served with no-cache.
   - admin: the heading is visible and `/api/health` returns ok.
4. **Scripts and tasks:**
   - add a `test:e2e` script (`playwright test`) to both apps;
   - in `turbo.json`, add `test:e2e` depending on `build` with `cache: false`;
   - add root scripts `test`, `test:int` and `test:e2e` that call `turbo run`.

**Understand it:** integration tests never touch your development data. Each test file creates its own `gym_test_*` database, and worker tests use Redis database 15.

**Check:** with services running, `pnpm test`, `pnpm test:int` and `pnpm test:e2e` all finish green.

## Phase 14 — Lint, format and CI

**Goal:** a machine checks every push, so broken code cannot reach `main`.

1. **Lint.** The starter's `@gym/eslint-config` already covers apps and packages, and every package's `lint` script uses `--max-warnings 0`. Add one rule to the shared configs: `no-restricted-imports`, so that
   - packages never import from apps (dependencies point inward);
   - apps import from `@gym/db`, never from Prisma's `generated` folder.
2. **Format.** The starter has Prettier and a root `format` script.
   - Add a `format:check` script (`prettier --check .`).
   - Add a `.prettierignore` listing the lockfile, `generated`, `.next` and `dist`.
   - Run `pnpm format` once.
3. **CI.** Create `.github/workflows/ci.yml` with two jobs on every push to `main` and every pull request.

   **checks** runs on `ubuntu-latest` with Postgres 18 and Redis 8 as service containers (same user and password as your Compose file). Steps:
   1. check out;
   2. set up pnpm (reads the version from `packageManager`);
   3. set up Node from `.nvmrc` with the pnpm cache;
   4. `pnpm install --frozen-lockfile`;
   5. `cp .env.example .env`;
   6. create the roles by running `infra/postgres/01-roles.sql` with `psql`;
   7. `pnpm db:deploy`;
   8. `pnpm format:check`, `pnpm lint`, `pnpm check-types`, `pnpm test`, `pnpm test:int`, `pnpm build`.

   **e2e** runs after checks with the same services and setup, then `playwright install --with-deps chromium` and `pnpm test:e2e`. It uploads the Playwright report when something fails.
4. **Protect `main`.** On GitHub: Settings → Branches → add a rule for `main` requiring both jobs to pass before merging.

**Understand it:** `--frozen-lockfile` fails CI when `package.json` and the lockfile disagree. `db:deploy` applies existing migrations only and never creates new ones, so CI tests exactly the schema you committed. Copying `.env.example` works because CI's throwaway services use the same development passwords.

**Check:** locally `pnpm format:check && pnpm lint && pnpm check-types` passes. After your first push, the Actions tab shows both jobs green.

## Phase 15 — Docker images

**Goal:** one small production image per app, built from the repo root, running as a non-root user and reporting its own health. These images are what you deploy to EC2.

### 15.1 Prepare the Next apps

1. In both `next.config.ts` files:
   - set `output` to `"standalone"` only when the environment variable `BUILD_STANDALONE` is `"1"`. Locally `next start` is used, and it does not support standalone output.
   - set `outputFileTracingRoot` to the monorepo root, so the standalone bundle includes our workspace packages.
2. Check that `next build` works without a `.env` file: rename `.env` for a moment and run `pnpm build`. If it fails with "Invalid environment configuration", some file reads env at import time. Move that read inside `getEnv()` or `getDb()` (Phase 6).

### 15.2 Bundle the worker

1. `pnpm --filter worker add -D esbuild`.
2. Create `apps/worker/build.mjs`, which calls esbuild to bundle `src/index.ts` into `dist/index.mjs`:
   - platform node, format ESM;
   - bundle **everything**: with pnpm, third-party packages live inside each workspace package's own `node_modules`, so leaving them external fails at runtime with "Cannot find package";
   - mark only `pg-native` as external, an optional add-on we do not use;
   - add a banner that defines `require` with `createRequire`, because some bundled dependencies are CommonJS.
3. Add `build` (`node build.mjs`) and `start` (`node dist/index.mjs`) scripts.

### 15.3 Write the Dockerfiles

1. **`.dockerignore`** at the root: `node_modules`, `.next`, `dist`, `.turbo`, `generated`, `.git`, and `.env` (keep `.env.example`).
2. **One Dockerfile per app** (`apps/web/Dockerfile`, `apps/admin/Dockerfile`, `apps/worker/Dockerfile`), always built from the repo root, with three stages:
   - **prune:** a `node:24-alpine` image with `turbo` installed globally runs `turbo prune <app> --docker`. That copies only the files the app needs, split into `out/json` (package files plus lockfile) and `out/full` (source).
   - **build:** installs `libc6-compat`, `openssl` and pnpm. Copies `out/json` and runs `pnpm install --frozen-lockfile`; this layer is cached until a dependency changes. Then copies `out/full` and runs `pnpm turbo run build --filter=<app>` with `BUILD_STANDALONE=1`.
   - **run:** a clean `node:24-alpine` and a non-root user. Next apps copy `.next/standalone`, `.next/static` and `public`, then start `node apps/<app>/server.js`. The worker copies only `dist` and starts `node dist/index.mjs`. Add a `HEALTHCHECK` that calls `/api/health` (port 4100 `/health` for the worker).
3. Give admin an empty `public/.gitkeep` so its COPY step always has a folder.
4. Build and run one locally:

```bash
docker build -f apps/web/Dockerfile -t gym-web .
docker run --rm -p 3000:3000 --env-file .env -e DATABASE_URL=postgresql://gym_app:<password>@host.docker.internal:5432/gym -e REDIS_URL=redis://host.docker.internal:6379 gym-web
```

**Understand it:**

- Standalone output is about 50 MB instead of the full `node_modules`.
- No secrets are baked into images. Variables arrive at runtime from EC2 or Secrets Manager, and a missing one stops the server at startup with a clear list.
- Inside a container `localhost` is the container itself. That is why the example uses `host.docker.internal`; on Linux, add `--add-host=host.docker.internal:host-gateway`.

**Check:** `docker images` lists the three images; `docker ps` shows each running container as `(healthy)` after about 30 seconds.

## Final check

Run this from a fresh clone. When every box is ticked, the foundation is done and M1 (logins, gyms, branches, roles) can start.

```bash
cp .env.example .env
pnpm install
pnpm services:up
pnpm db:migrate
pnpm format:check && pnpm lint && pnpm check-types && pnpm test && pnpm test:int && pnpm build
pnpm test:e2e
pnpm dev
```

- [ ] `pnpm install` finishes with no "ignored build scripts" error.
- [ ] `docker compose ps` shows Postgres, Redis, MinIO and Mailpit healthy.
- [ ] Lint, type checks, tests and builds all report "Tasks: N successful".
- [ ] The 7 row-level-security tests and 4 queue tests pass.
- [ ] http://localhost:3000/api/health, http://localhost:3001/api/health and http://localhost:4100/health all return ok.
- [ ] `curl -X POST localhost:3000/api/dev/ping` makes the worker log "pong".
- [ ] http://localhost:3000/m is installable and shows the offline page when offline.
- [ ] Stopping Postgres turns the health checks to 503, and starting it again restores them.
- [ ] Ctrl+C on `pnpm dev` makes the worker log "shutting down" then "bye".
- [ ] The three Docker images build and run healthy.
- [ ] Both CI jobs are green on GitHub, and `main` is protected.

## Common problems and fixes

| You see | Why | Fix |
| --- | --- | --- |
| "Relative import paths need explicit file extensions" | The starter's TypeScript base uses `NodeNext` | Set `module` to `ESNext` and `moduleResolution` to `Bundler` in `packages/typescript-config/base.json` (Phase 3) |
| `pnpm install` fails with "Ignored build scripts" | pnpm blocks install scripts until you decide | In `pnpm-workspace.yaml` under `allowBuilds:`, replace each "set this to true or false": `true` for Prisma and esbuild, `false` for `msgpackr-extract`, `sharp`, `unrs-resolver` |
| "Cannot find name 'LayoutProps'" in admin | Admin's tsconfig misses Next's generated types | Include `.next/dev/types/**/*.ts` as well as `.next/types/**/*.ts` (Phase 4) |
| `next build` fails fetching a font | The scaffold uses Google's Geist via `next/font/google` | Build once with internet access, or switch to a local font |
| `pnpm add prisma` installs 8.0.0-rc | npm's `latest` tag is a release candidate | Always pin `@7.10.1` for `prisma`, `@prisma/client` and `@prisma/adapter-pg` |
| "Cannot resolve environment variable: MIGRATION\_DATABASE\_URL" during `prisma generate` | The URL is required unconditionally in `prisma.config.ts` | Set the datasource only when the variable exists (Phase 8.3) |
| `next build` fails with "Invalid environment configuration" in Docker | A file validates env at import time | Use lazy `getEnv()` / `getDb()` and validate in `instrumentation.ts` (Phase 6) |
| Lint fails on `turbo/no-undeclared-env-vars` | A variable your code reads is not listed in `turbo.json` | Add it to `globalEnv` |
| Tailwind classes from `@gym/ui` have no styles | Tailwind does not scan outside the app folder | Add an `@source` line pointing at `packages/ui/src` (Phase 10) |
| Worker image: "Cannot find package 'zod'" | Third-party packages were left out of the bundle | Bundle everything except `pg-native` (Phase 15.2) |
| BullMQ "Custom Id cannot contain :" | Job ids become Redis keys | The envelope schema rejects `:` and plain integers in the idempotency key |
| "permission denied for schema platform" | Working as intended: `gym_app` must not read platform data | Use `PLATFORM_DATABASE_URL` only in the admin app |
| Changed `01-roles.sql` has no effect | Init scripts run only when the volume is first created | `docker compose down -v && pnpm services:up` (deletes local data) |
| Port 5432 already in use | A local Postgres is running | Stop it, or map another host port in Compose and update the URLs in `.env` |
| Service worker changes do not show | The old worker still controls the page | Bump `VERSION` in `sw.js`, or Unregister in DevTools → Application |
