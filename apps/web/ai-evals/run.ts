/**
 * Copilot evaluation runner (M8). Asks every question in questions.json as the gym owner of the
 * seeded demo gym, through the real orchestration (permissions, tools, grounding), and scores:
 *   - tools: the answer used at least one expected tool; with none expected (actions, secrets,
 *     other gyms, forecasts) it must not propose anything (every other tool is read-only)
 *   - grounded: no numbers outside the tool results
 *   - kpis: KPI values stated as the KPI service computes them
 *   - listMatchesKpi: a list tool's count equals the KPI's count
 *   - contains / absent: wording checks
 * Not in CI (it needs a provider). CI covers the orchestration with the fake provider.
 *
 *   pnpm ai:eval                 # the provider configured in the admin console (must be enabled)
 *   pnpm ai:eval -- --fake       # the deterministic fake (no network)
 *   pnpm ai:eval -- --only expiring-week,overdue
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { grantsFor } from "@gym/auth/permissions";
import type { AuthContext } from "@gym/core/authz";
import { askCopilot, type CopilotAnswer } from "@gym/core/copilot";
import { createSecretBox } from "@gym/core/crypto";
import { noEntitlementCache } from "@gym/core/entitlements";
import { getKpis, type KpiKey } from "@gym/core/metrics";
import { formatMoney, money } from "@gym/core/money";
import { loadTenantAccess, type CoreDeps } from "@gym/core/tenancy";
import { createPrismaClient } from "@gym/db";
import { createOpenAiClient } from "@gym/integrations/ai";
import { config as loadDotenv } from "dotenv";

loadDotenv({
  path: path.resolve(import.meta.dirname, "../../../.env"),
  quiet: true,
});

type Question = {
  id: string;
  q: string;
  tools: string[];
  kpis?: KpiKey[];
  listMatchesKpi?: KpiKey;
  contains?: string[];
  absent?: string[];
};

const file = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "questions.json"), "utf8"),
) as { gym: string; questions: Question[] };
const fake = process.argv.includes("--fake");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const only =
  process.argv.includes("--only") && onlyArg
    ? new Set(onlyArg.split(","))
    : null;

if (process.env.NODE_ENV === "production") {
  console.error("The eval runs against seeded demo data: not in production.");
  process.exit(1);
}
const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const kek = process.env.DATA_ENCRYPTION_KEY;
if (!appUrl || !ownerUrl || !kek) {
  console.error(
    "DATABASE_URL, MIGRATION_DATABASE_URL and DATA_ENCRYPTION_KEY must be set (see .env).",
  );
  process.exit(1);
}

const app = createPrismaClient(appUrl);
// Owner connection: only to find the demo gym and its owner (like the seed script). Questions run on gym_app.
const platform = createPrismaClient(ownerUrl);
const secrets = createSecretBox({
  key: kek,
  previousKey: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,
});
const deps: CoreDeps = { db: app, entitlements: noEntitlementCache, secrets };

function fmt(unit: string, v: number | null) {
  if (v === null) return null;
  if (unit === "money") return formatMoney(money(v, "INR"));
  if (unit === "ratio") return `${(v * 100).toFixed(1)}%`;
  return String(v);
}

async function ownerContext(): Promise<AuthContext> {
  const tenant = await platform.tenant.findUnique({
    where: { slug: file.gym },
    select: { id: true },
  });
  if (!tenant)
    throw new Error(`Gym "${file.gym}" not found: run pnpm db:seed first.`);
  const owners = await platform.$queryRaw<{ user_id: string }[]>`
    SELECT m.user_id::text FROM app.tenant_membership m JOIN app.role_assignment r ON r.membership_id = m.id
     WHERE m.tenant_id = ${tenant.id}::uuid AND r.role_key = 'GYM_OWNER' LIMIT 1`;
  const userId = owners[0]?.user_id;
  if (!userId) throw new Error("The demo gym has no owner.");
  const access = await loadTenantAccess(app, userId, tenant.id);
  if (!access) throw new Error("That user has no access to the gym.");
  return {
    userId,
    tenantId: tenant.id,
    membershipId: access.membershipId,
    grants: grantsFor(access.roles),
    activeBranchId: null,
    tenantStatus: access.tenant.status,
    subscriptionStatus: access.subscription?.status ?? null,
    timezone: access.tenant.timezone,
  };
}

type Score = {
  id: string;
  ok: boolean;
  checks: Record<string, boolean>;
  tools: string[];
  outcome: string;
  ms: number;
  answer: string;
  note?: string;
};

try {
  const ctx = await ownerContext();
  // No per-gym rate limit here (36 questions in a row); rate limiting has its own integration test.
  const ai = {
    factory: createOpenAiClient,
    fake,
    limiter: { hit: async () => true },
  };
  const provider = fake
    ? null
    : await platform.aiProvider.findUnique({
        where: { id: "default" },
        select: {
          label: true,
          model: true,
          enabled: true,
          supportsTools: true,
        },
      });
  if (!fake && !provider?.enabled)
    throw new Error(
      "No enabled AI provider. Configure one in the admin console, or use --fake.",
    );
  const scores: Score[] = [];
  for (const item of file.questions) {
    if (only && !only.has(item.id)) continue;
    const t0 = Date.now();
    let res: CopilotAnswer;
    try {
      res = await askCopilot(deps, ai, ctx, { question: item.q });
    } catch (err) {
      scores.push({
        id: item.id,
        ok: false,
        checks: { ran: false },
        tools: [],
        outcome: "ERROR",
        ms: Date.now() - t0,
        answer: "",
        note: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const used = [...new Set(res.results.map((r) => r.tool))];
    const text = res.answer.toLowerCase();
    const checks: Record<string, boolean> = {
      tools: item.tools.length
        ? used.some((t) => item.tools.includes(t))
        : res.proposals.length === 0,
      grounded: res.ungrounded.length === 0,
    };
    if (item.kpis?.length) {
      const k = await getKpis(deps, ctx, {
        keys: item.kpis,
        preset: "this_month",
        branchId: "all",
      });
      checks.kpis = k.figures.every((f) => {
        const shown = fmt(f.unit, f.value);
        return (
          shown === null ||
          res.answer.includes(shown) ||
          res.answer.includes(shown.replace(".00", ""))
        );
      });
    }
    if (item.listMatchesKpi) {
      const k = await getKpis(deps, ctx, {
        keys: [item.listMatchesKpi],
        branchId: "all",
      });
      const count = (res.results[0]?.data as { count?: number } | undefined)
        ?.count;
      checks.listMatchesKpi = count === k.figures[0]?.value;
    }
    if (item.contains?.length)
      checks.contains = item.contains.every((s) =>
        text.includes(s.toLowerCase()),
      );
    if (item.absent?.length)
      checks.absent = item.absent.every((s) => !text.includes(s.toLowerCase()));
    scores.push({
      id: item.id,
      ok: Object.values(checks).every(Boolean),
      checks,
      tools: used,
      outcome: res.outcome,
      ms: Date.now() - t0,
      answer: res.answer,
    });
    process.stdout.write(
      `${scores.at(-1)!.ok ? "PASS" : "FAIL"} ${item.id} (${used.join(", ") || "no tools"}, ${res.outcome}, ${Date.now() - t0} ms)\n`,
    );
  }
  const passed = scores.filter((s) => s.ok).length;
  const label = fake
    ? "fake provider"
    : `${provider!.label} / ${provider!.model}${provider!.supportsTools === false ? " (fallback mode)" : ""}`;
  const stamp = new Date().toISOString().slice(0, 16).replace(":", "");
  const dir = path.join(import.meta.dirname, "results");
  mkdirSync(dir, { recursive: true });
  const md = [
    `# Copilot eval — ${label}`,
    "",
    `Run ${new Date().toISOString()} on ${file.gym}: **${passed}/${scores.length} passed**.`,
    "",
    "| Question | Result | Tools | Outcome | ms | Failed checks |",
    "|---|---|---|---|---|---|",
    ...scores.map(
      (s) =>
        `| ${s.id} | ${s.ok ? "pass" : "FAIL"} | ${s.tools.join(", ") || "—"} | ${s.outcome} | ${s.ms} | ${
          Object.entries(s.checks)
            .filter(([, v]) => !v)
            .map(([k]) => k)
            .join(", ") ||
          (s.note ?? "")
        } |`,
    ),
  ].join("\n");
  writeFileSync(
    path.join(dir, `${stamp}-${fake ? "fake" : "provider"}.md`),
    md + "\n",
  );
  // Answers can contain member names: kept only in the local, git-ignored results folder.
  writeFileSync(
    path.join(dir, `${stamp}-${fake ? "fake" : "provider"}.json`),
    JSON.stringify({ label, scores }, null, 2),
  );
  console.log(
    `\n${passed}/${scores.length} passed (${label}). Report: ai-evals/results/${stamp}-${fake ? "fake" : "provider"}.md`,
  );
  process.exitCode = passed === scores.length ? 0 : 1;
} finally {
  await app.$disconnect();
  await platform.$disconnect();
}
