/** Fixed tenant roles (D-07). The permission matrix is in packages/auth/src/permissions.ts. */
export const TENANT_ROLES = {
  GYM_OWNER: {
    label: "Gym Owner",
    description: "Full control, including the SaaS subscription.",
    staff: true,
    mfa: "required",
  },
  GYM_ADMIN: {
    label: "Gym Administrator",
    description: "Runs the gym day to day across all branches.",
    staff: true,
    mfa: "required",
  },
  BRANCH_MANAGER: {
    label: "Branch Manager",
    description: "Manages one branch: staff, members, money.",
    staff: true,
    mfa: "tenant-setting",
  },
  RECEPTIONIST: {
    label: "Receptionist",
    description: "Front desk: members, check-ins, collecting payments.",
    staff: true,
    mfa: "tenant-setting",
  },
  SALES_STAFF: {
    label: "Sales Staff",
    description: "Leads and selling memberships.",
    staff: true,
    mfa: "tenant-setting",
  },
  TRAINER: {
    label: "Trainer",
    description: "Classes, workouts and nutrition. No payments.",
    staff: true,
    mfa: "tenant-setting",
  },
  ACCOUNTANT: {
    label: "Accountant",
    description: "Invoices, payments, refunds and financial reports.",
    staff: true,
    mfa: "tenant-setting",
  },
  MEMBER: {
    label: "Member",
    description: "Uses the member app.",
    staff: false,
    mfa: "optional",
  },
} as const satisfies Record<
  string,
  {
    label: string;
    description: string;
    staff: boolean;
    mfa: "required" | "tenant-setting" | "optional";
  }
>;

export type TenantRoleKey = keyof typeof TENANT_ROLES;

export const TENANT_ROLE_KEYS = Object.keys(TENANT_ROLES) as TenantRoleKey[];

/** Roles that staff invitations can grant (members join through M2 member invites). */
export const STAFF_ROLE_KEYS = TENANT_ROLE_KEYS.filter(
  (key) => TENANT_ROLES[key].staff,
);

export function isTenantRoleKey(key: string): key is TenantRoleKey {
  return key in TENANT_ROLES;
}

export function roleLabel(key: string): string {
  return isTenantRoleKey(key) ? TENANT_ROLES[key].label : key;
}

/** True when any of `roles` is a staff role (used for the staff.max quota). */
export function hasStaffRole(roles: readonly string[]): boolean {
  return roles.some((key) => isTenantRoleKey(key) && TENANT_ROLES[key].staff);
}

/**
 * D-03: is the email OTP second factor required for this set of roles in this tenant?
 * Owner/Administrator: always. Other staff: when the tenant requires it. Members: no (opt-in later).
 */
export function mfaRequirement(
  roles: readonly string[],
  require2faForStaff: boolean,
): { required: boolean; trustedDeviceAllowed: boolean } {
  const known = roles.filter(isTenantRoleKey);
  if (known.some((key) => TENANT_ROLES[key].mfa === "required")) {
    return { required: true, trustedDeviceAllowed: false };
  }
  if (
    require2faForStaff &&
    known.some((key) => TENANT_ROLES[key].mfa === "tenant-setting")
  ) {
    return { required: true, trustedDeviceAllowed: true };
  }
  return { required: false, trustedDeviceAllowed: true };
}
