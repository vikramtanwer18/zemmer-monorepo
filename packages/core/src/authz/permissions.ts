/**
 * Permission keys. The role → permission matrix lives in packages/auth/src/permissions.ts;
 * services only ever check keys (never role names), so custom roles can drop in later (D-07).
 *
 * scope "tenant": only a role assigned to all branches grants it (e.g. settings.manage).
 * scope "branch": a role assigned to branch X grants it for branch X only.
 */
export const PERMISSIONS = {
  "dashboard.view": {
    scope: "branch",
    module: "Dashboard",
    description: "See the dashboard",
  },

  "branches.view": {
    scope: "branch",
    module: "Branches",
    description: "See branch details",
  },
  "branches.manage": {
    scope: "tenant",
    module: "Branches",
    description: "Create, edit and archive branches",
  },

  "staff.view": {
    scope: "branch",
    module: "Staff",
    description: "See staff and invitations",
  },
  "staff.invite": {
    scope: "branch",
    module: "Staff",
    description: "Invite staff to a branch",
  },
  "staff.manage": {
    scope: "branch",
    module: "Staff",
    description: "Change roles, deactivate staff",
  },
  "staff.assign_admin": {
    scope: "tenant",
    module: "Staff",
    description: "Grant the Gym Administrator role",
  },
  "staff.assign_owner": {
    scope: "tenant",
    module: "Staff",
    description: "Grant the Gym Owner role",
  },

  "settings.view": {
    scope: "tenant",
    module: "Settings",
    description: "See organisation settings",
  },
  "settings.manage": {
    scope: "tenant",
    module: "Settings",
    description: "Change organisation, tax and security settings",
  },
  "settings.payments": {
    scope: "tenant",
    module: "Settings",
    description: "Connect and manage the gym's Razorpay account",
  },
  "subscription.view": {
    scope: "tenant",
    module: "Settings",
    description: "See the SaaS plan and usage",
  },
  "subscription.manage": {
    scope: "tenant",
    module: "Settings",
    description: "Change or pay for the SaaS plan",
  },
  "audit.view": {
    scope: "tenant",
    module: "Settings",
    description: "Read the audit log",
  },

  "members.view": {
    scope: "branch",
    module: "Members",
    description: "See members",
  },
  "members.create": {
    scope: "branch",
    module: "Members",
    description: "Add members",
  },
  "members.edit": {
    scope: "branch",
    module: "Members",
    description: "Edit members",
  },
  "members.delete": {
    scope: "branch",
    module: "Members",
    description: "Delete or anonymise members",
  },
  "members.export": {
    scope: "branch",
    module: "Members",
    description: "Export member lists",
  },
  "members.import": {
    scope: "tenant",
    module: "Members",
    description: "Import members from a CSV file",
  },
  "members.notes_private": {
    scope: "branch",
    module: "Members",
    description: "Read and write management-only member notes",
  },

  "memberships.view": {
    scope: "branch",
    module: "Memberships",
    description: "See memberships",
  },
  "memberships.sell": {
    scope: "branch",
    module: "Memberships",
    description: "Sell and renew memberships",
  },
  "memberships.manage": {
    scope: "branch",
    module: "Memberships",
    description: "Freeze, transfer and cancel memberships",
  },
  "plans.manage": {
    scope: "tenant",
    module: "Memberships",
    description: "Create and edit membership plans",
  },

  "billing.view": {
    scope: "branch",
    module: "Billing",
    description: "See invoices and payments",
  },
  "billing.collect": {
    scope: "branch",
    module: "Billing",
    description: "Record payments",
  },
  "billing.refund": {
    scope: "branch",
    module: "Billing",
    description: "Refund payments and issue credit notes",
  },
  "billing.void": {
    scope: "branch",
    module: "Billing",
    description: "Void recorded payments and unpaid invoices",
  },
  "billing.configure": {
    scope: "tenant",
    module: "Billing",
    description: "Payment provider and invoice settings",
  },

  "attendance.view": {
    scope: "branch",
    module: "Attendance",
    description: "See check-ins",
  },
  "attendance.scan": {
    scope: "branch",
    module: "Attendance",
    description: "Scan member passes and check members in by hand",
  },
  "attendance.override": {
    scope: "branch",
    module: "Attendance",
    description:
      "Check a member in when the rules would refuse (with a reason)",
  },
  "attendance.correct": {
    scope: "branch",
    module: "Attendance",
    description: "Correct or remove check-in records (with a reason)",
  },

  "classes.view": {
    scope: "branch",
    module: "Classes",
    description: "See the class schedule",
  },
  "classes.manage": {
    scope: "branch",
    module: "Classes",
    description: "Create and edit classes, rooms and categories",
  },
  "classes.attendance": {
    scope: "branch",
    module: "Classes",
    description: "Mark class attendance and no-shows",
  },
  "bookings.manage": {
    scope: "branch",
    module: "Classes",
    description: "Book and cancel for members",
  },

  "clients.view": {
    scope: "branch",
    module: "Trainers",
    description: "See one's own assigned clients (no payments)",
  },
  "trainers.assign": {
    scope: "branch",
    module: "Trainers",
    description: "Assign trainers to members",
  },
  "pt.manage": {
    scope: "branch",
    module: "Trainers",
    description: "Book, complete and cancel any trainer's PT sessions",
  },
  "pt.own": {
    scope: "branch",
    module: "Trainers",
    description: "Book, complete and cancel one's own PT sessions",
  },
  "staff.compensation.view": {
    scope: "tenant",
    module: "Staff",
    description: "See and edit staff pay details",
  },

  "leads.view": { scope: "branch", module: "CRM", description: "See leads" },
  "leads.manage": {
    scope: "branch",
    module: "CRM",
    description: "Create and work leads",
  },
  "leads.assign": {
    scope: "branch",
    module: "CRM",
    description: "Give leads to other staff",
  },
  "leads.import": {
    scope: "tenant",
    module: "CRM",
    description: "Import leads from a file",
  },
  "leads.export": {
    scope: "branch",
    module: "CRM",
    description: "Export leads",
  },
  "tasks.manage": {
    scope: "branch",
    module: "CRM",
    description: "Create, assign and complete follow-up tasks",
  },
  "crm.configure": {
    scope: "tenant",
    module: "CRM",
    description:
      "Pipeline stages, sources, lost reasons, campaigns, capture forms and API keys",
  },

  "messaging.send": {
    scope: "branch",
    module: "Messaging",
    description: "Send messages and campaigns",
  },
  "messaging.configure": {
    scope: "tenant",
    module: "Messaging",
    description: "WhatsApp and email configuration",
  },
  "marketing.send": {
    scope: "tenant",
    module: "Messaging",
    description:
      "Build audiences and launch WhatsApp campaigns (bulk promotional sends)",
  },
  "automations.manage": {
    scope: "tenant",
    module: "Automation",
    description: "Create, edit, enable and dry-run automation workflows",
  },
  "automations.approve": {
    scope: "branch",
    module: "Automation",
    description: "Approve or reject automation steps waiting for a person",
  },
  "retention.view": {
    scope: "branch",
    module: "Retention",
    description:
      "See at-risk members, act on retention flags and recovery outcomes",
  },

  "fitness.manage": {
    scope: "branch",
    module: "Fitness",
    description:
      "Exercise and food libraries, workout templates; plans, assessments and feedback for assigned clients",
  },
  "fitness.view_all": {
    scope: "tenant",
    module: "Fitness",
    description:
      "See every member's health and fitness data (not only assigned clients)",
  },
  "fitness.export": {
    scope: "tenant",
    module: "Fitness",
    description: "Download a member's health and fitness data",
  },
  "engagement.manage": {
    scope: "tenant",
    module: "Engagement",
    description:
      "Announcements, challenges, achievements, reward rules and perks",
  },
  "rewards.fulfil": {
    scope: "branch",
    module: "Engagement",
    description: "Hand over or refuse perks members redeemed with points",
  },

  "reports.view": {
    scope: "branch",
    module: "Reports",
    description: "See operational reports",
  },
  "reports.financial": {
    scope: "branch",
    module: "Reports",
    description: "See revenue and financial reports",
  },
  "reports.export": {
    scope: "branch",
    module: "Reports",
    description: "Export reports",
  },

  "ai.use": {
    // M8: branch-scoped so branch managers can ask about their own branches (tools narrow data).
    scope: "branch",
    module: "AI",
    description:
      "Ask the AI copilot (answers cover only the data the user may see)",
  },

  "expenses.manage": {
    scope: "branch",
    module: "Finance",
    description: "Record expenses",
  },
  "pos.sell": { scope: "branch", module: "POS", description: "Sell products" },
  "inventory.manage": {
    scope: "branch",
    module: "POS",
    description: "Manage stock",
  },

  "member.self": {
    scope: "branch",
    module: "Member app",
    description: "Use the member app for one's own membership",
  },
} as const satisfies Record<
  string,
  { scope: "tenant" | "branch"; module: string; description: string }
>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(key: string): key is PermissionKey {
  return key in PERMISSIONS;
}
