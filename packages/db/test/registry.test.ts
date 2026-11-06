import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GLOBAL_APP_MODELS, TENANT_MODELS } from "../src/tenant-models";

const schema = readFileSync(
  path.resolve(import.meta.dirname, "../prisma/schema.prisma"),
  "utf8",
);

type ParsedModel = { name: string; schema: string; hasTenantId: boolean };

function parseModels(source: string): ParsedModel[] {
  const models: ParsedModel[] = [];
  for (const match of source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name = "", body = ""] = match;
    models.push({
      name,
      schema: /@@schema\("(\w+)"\)/.exec(body)?.[1] ?? "",
      hasTenantId: /^\s+tenantId\s/m.test(body),
    });
  }
  return models;
}

const models = parseModels(schema);
const appModels = models.filter((m) => m.schema === "app");

describe("tenant model registry", () => {
  it("parses the schema", () => {
    expect(appModels.length).toBeGreaterThan(5);
  });

  it("lists every app model exactly once (tenant-owned or global)", () => {
    const listed = [...TENANT_MODELS, ...GLOBAL_APP_MODELS] as string[];
    expect(new Set(listed).size).toBe(listed.length);
    expect(appModels.map((m) => m.name).sort()).toEqual([...listed].sort());
  });

  it("registers every app model that has a tenantId", () => {
    const withTenant = appModels
      .filter((m) => m.hasTenantId)
      .map((m) => m.name);
    expect(withTenant.sort()).toEqual([...TENANT_MODELS].sort());
  });

  it("keeps global identity models free of tenantId", () => {
    for (const name of GLOBAL_APP_MODELS) {
      expect(appModels.find((m) => m.name === name)?.hasTenantId).toBe(false);
    }
  });
});
