/**
 * The audience builder is a plain form (works without JavaScript); this turns its fields into a
 * segment definition and back. The core validates the result (segmentDefinitionSchema), so
 * nothing here is trusted.
 */
type Params = Record<string, string | string[] | undefined>;

const list = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
const one = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v)?.trim() || "";
const num = (v: string | string[] | undefined) => {
  const s = one(v);
  return s === "" ? null : Number(s);
};
const tags = (v: string | string[] | undefined) =>
  one(v)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

export function definitionFromParams(p: Params) {
  const entity = one(p.entity) === "LEAD" ? "LEAD" : "MEMBER";
  const conditions: Record<string, unknown>[] = [];
  if (entity === "MEMBER") {
    if (list(p.status).length)
      conditions.push({ field: "status", op: "in", value: list(p.status) });
    if (list(p.branch).length)
      conditions.push({ field: "branch", op: "in", value: list(p.branch) });
    if (list(p.plan).length)
      conditions.push({ field: "plan", op: "in", value: list(p.plan) });
    if (one(p.membership))
      conditions.push({
        field: "membership",
        op: "is",
        value: one(p.membership),
      });
    if (num(p.expiresMax) !== null)
      conditions.push({
        field: "expiresInDays",
        op: "between",
        value: { min: num(p.expiresMin) ?? 0, max: num(p.expiresMax) },
      });
    if (num(p.expiredMax) !== null)
      conditions.push({
        field: "expiredDaysAgo",
        op: "between",
        value: { min: num(p.expiredMin) ?? 0, max: num(p.expiredMax) },
      });
    if (num(p.noVisitDays) !== null)
      conditions.push({
        field: "lastVisitDaysAgo",
        op: "gte",
        value: num(p.noVisitDays),
      });
    if (num(p.visitedWithin) !== null)
      conditions.push({
        field: "lastVisitDaysAgo",
        op: "lte",
        value: num(p.visitedWithin),
      });
    if (tags(p.tagsAny).length)
      conditions.push({ field: "tags", op: "hasAny", value: tags(p.tagsAny) });
    if (tags(p.tagsNone).length)
      conditions.push({
        field: "tags",
        op: "hasNone",
        value: tags(p.tagsNone),
      });
    if (num(p.joinedWithin) !== null)
      conditions.push({
        field: "joinedDaysAgo",
        op: "lte",
        value: num(p.joinedWithin),
      });
  } else {
    if (list(p.stage).length)
      conditions.push({ field: "stage", op: "in", value: list(p.stage) });
    if (list(p.leadStatus).length)
      conditions.push({
        field: "leadStatus",
        op: "in",
        value: list(p.leadStatus),
      });
    if (list(p.branch).length)
      conditions.push({ field: "branch", op: "in", value: list(p.branch) });
    if (list(p.source).length)
      conditions.push({ field: "source", op: "in", value: list(p.source) });
    if (list(p.campaign).length)
      conditions.push({ field: "campaign", op: "in", value: list(p.campaign) });
    if (num(p.createdWithin) !== null)
      conditions.push({
        field: "createdDaysAgo",
        op: "lte",
        value: num(p.createdWithin),
      });
  }
  return { entity, match: one(p.match) === "ANY" ? "ANY" : "ALL", conditions };
}

/** A saved definition back into form values (for editing). */
export function paramsFromDefinition(def: {
  entity: string;
  match: string;
  conditions: { field: string; op: string; value: unknown }[];
}): Params {
  const p: Params = { entity: def.entity, match: def.match };
  for (const c of def.conditions) {
    const v = c.value as never;
    switch (c.field) {
      case "status":
      case "branch":
      case "plan":
      case "stage":
      case "leadStatus":
      case "source":
      case "campaign":
        p[c.field] = v as string[];
        break;
      case "membership":
        p.membership = v as string;
        break;
      case "expiresInDays":
        p.expiresMin = String((v as { min: number }).min);
        p.expiresMax = String((v as { max: number }).max);
        break;
      case "expiredDaysAgo":
        p.expiredMin = String((v as { min: number }).min);
        p.expiredMax = String((v as { max: number }).max);
        break;
      case "lastVisitDaysAgo":
        p[c.op === "gte" ? "noVisitDays" : "visitedWithin"] = String(v);
        break;
      case "tags":
        p[c.op === "hasAny" ? "tagsAny" : "tagsNone"] = (v as string[]).join(
          ", ",
        );
        break;
      case "joinedDaysAgo":
        p.joinedWithin = String(v);
        break;
      case "createdDaysAgo":
        p.createdWithin = String(v);
        break;
    }
  }
  return p;
}
