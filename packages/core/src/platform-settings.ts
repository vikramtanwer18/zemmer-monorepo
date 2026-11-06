import type { Prisma } from "@gym/db";
import { z } from "zod";

/** Platform settings with their types and defaults. Stored as JSON rows in platform.platform_setting. */
export const PLATFORM_SETTINGS = {
  "tenant.approval_required": z.boolean().default(false),
  "trial.days": z.number().int().min(0).max(365).default(14),
  "trial.plan_code": z.string().min(1).default("starter"),
  "trial.expired_status": z
    .enum(["SUSPENDED", "GRACE", "PAST_DUE"])
    .default("SUSPENDED"),
  // --- M4: SaaS billing
  /** Days of read-write grace after the provider stops retrying a failed payment. */
  "billing.grace_days": z.number().int().min(0).max(60).default(7),
  /** The operator, as supplier on SaaS invoices (GSTIN empty = no GST charged). */
  "billing.supplier": z
    .object({
      legalName: z.string().default("Fonix Technologies"),
      gstin: z.string().nullable().default(null),
      stateCode: z.string().default("08"),
      address: z.string().default(""),
    })
    .default({
      legalName: "Fonix Technologies",
      gstin: null,
      stateCode: "08",
      address: "",
    }),
  /** SAC code on SaaS invoices (to be confirmed by the CA). */
  "billing.sac_code": z.string().min(4).max(8).default("998315"),
  /** GST rate on SaaS invoices, basis points; prices are GST-inclusive. */
  "billing.tax_rate_bps": z.number().int().min(0).max(2800).default(1800),
  // --- M6: WhatsApp
  /**
   * Meta Embedded Signup for gyms. Off until the operator is an approved Meta Tech Provider and
   * META_APP_ID / META_EMBEDDED_SIGNUP_CONFIG_ID are set; gyms see "coming soon" until then.
   */
  "whatsapp.embedded_signup_enabled": z.boolean().default(false),
} as const;

export type PlatformSettingKey = keyof typeof PLATFORM_SETTINGS;
export type PlatformSettings = {
  [K in PlatformSettingKey]: z.infer<(typeof PLATFORM_SETTINGS)[K]>;
};

type SettingsReader = {
  platformSetting: {
    findMany(args: {
      where?: Prisma.PlatformSettingWhereInput;
    }): Promise<{ key: string; value: unknown }[]>;
  };
};

/** Reads every setting; a missing or invalid stored value falls back to its default. */
export async function readPlatformSettings(
  db: SettingsReader,
): Promise<PlatformSettings> {
  const rows = await db.platformSetting.findMany({});
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(PLATFORM_SETTINGS)) {
    const parsed = schema.safeParse(byKey.get(key));
    out[key] = parsed.success ? parsed.data : schema.parse(undefined);
  }
  return out as PlatformSettings;
}
