import { z } from "zod";
import { checkGstin, GSTIN_MESSAGES, isGstStateCode } from "../gst";
import { checkboxSchema, currencySchema, timezoneSchema } from "../validation";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const stateCodeSchema = z
  .string()
  .regex(/^\d{2}$/, "Pick a state.")
  .refine(isGstStateCode, "Pick a state.");

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .superRefine((value, ctx) => {
    const result = checkGstin(value);
    if (!result.valid) {
      ctx.addIssue({ code: "custom", message: GSTIN_MESSAGES[result.reason] });
    }
  });

export const branchInputSchema = z.object({
  name: z.string().trim().min(2, "Enter the branch name.").max(80),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,12}$/, "2–12 letters, digits or dashes, e.g. JPR-1."),
  addressLine1: optionalText(120),
  addressLine2: optionalText(120),
  city: optionalText(60),
  stateCode: stateCodeSchema,
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter a 6-digit PIN code.")
    .optional()
    .transform((v) => v ?? null),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{8,16}$/, "Enter a valid phone number.")
    .optional()
    .transform((v) => v ?? null),
  timezone: timezoneSchema.optional().transform((v) => v ?? null),
  gstin: gstinSchema.optional().transform((v) => v ?? null),
});

export type BranchInput = z.infer<typeof branchInputSchema>;

export const onboardingSchema = z.object({
  gymName: z.string().trim().min(2, "Enter your gym's name.").max(80),
  legalName: z.string().trim().max(120).optional(),
  timezone: timezoneSchema.default("Asia/Kolkata"),
  currency: currencySchema.default("INR"),
  stateCode: stateCodeSchema,
  branchName: z.string().trim().min(2, "Enter the branch name.").max(80),
  branchCity: optionalText(60),
  branchAddress: optionalText(120),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;

export const orgProfileSchema = z.object({
  displayName: z.string().trim().min(2, "Enter the gym's name.").max(80),
  legalName: z
    .string()
    .trim()
    .min(2, "Enter the registered business name.")
    .max(120),
  timezone: timezoneSchema,
  currency: currencySchema,
  locale: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, "Use a locale like en-IN."),
});

export const taxSettingsSchema = z
  .object({
    gstRegistered: checkboxSchema,
    gstin: z.string().trim().optional(),
    stateCode: stateCodeSchema,
    pricesIncludeTax: checkboxSchema,
  })
  .superRefine((value, ctx) => {
    if (!value.gstRegistered) return;
    if (!value.gstin) {
      ctx.addIssue({
        code: "custom",
        path: ["gstin"],
        message: "Enter your GSTIN.",
      });
      return;
    }
    const result = checkGstin(value.gstin);
    if (!result.valid) {
      ctx.addIssue({
        code: "custom",
        path: ["gstin"],
        message: GSTIN_MESSAGES[result.reason],
      });
    } else if (result.stateCode !== value.stateCode) {
      ctx.addIssue({
        code: "custom",
        path: ["gstin"],
        message: "The GSTIN's state code doesn't match the selected state.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    gstin:
      value.gstRegistered && value.gstin ? value.gstin.toUpperCase() : null,
  }));

export const securitySettingsSchema = z.object({
  require2faForStaff: checkboxSchema,
});

export const roleGrantSchema = z.object({
  roleKey: z.string().min(1),
  branchId: z.uuid().nullable(),
});

export const roleGrantsSchema = z
  .array(roleGrantSchema)
  .min(1, "Pick at least one role.")
  .max(10);

export type RoleGrantInput = z.infer<typeof roleGrantSchema>;
