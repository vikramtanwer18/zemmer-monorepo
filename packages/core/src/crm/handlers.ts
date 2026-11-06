import type { EventHandler } from "../events";
import { notify } from "../notifications";
import { crmStaff, leadName } from "./leads";

/**
 * M5's own consumers of CRM events (M6 automations will add more). Each runs once per event
 * (see dispatchEvent). Recipients are chosen by role: recipient choice, not access control.
 */
export const CRM_EVENT_HANDLERS: EventHandler[] = [
  {
    name: "crm.notify-new-lead",
    types: ["lead.created"],
    async handle(tx, tenantId, event) {
      if (event.type !== "lead.created") return;
      const data = event.data as {
        leadId: string;
        branchId: string;
        via: string;
        ownerUserId: string | null;
      };
      if (data.via === "STAFF" || data.via === "IMPORT") return;
      const lead = await tx.lead.findUnique({
        where: { id: data.leadId },
        include: { tasks: { where: { kind: "FIRST_CONTACT" } } },
      });
      if (!lead) return;
      const recipients = data.ownerUserId
        ? [data.ownerUserId]
        : (
            await crmStaff(tx, data.branchId, ["SALES_STAFF", "BRANCH_MANAGER"])
          ).map((s) => s.userId);
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
      });
      const due = lead.tasks[0]?.dueAt ?? lead.createdAt;
      for (const userId of recipients)
        await notify(tx, tenantId, {
          templateKey: "lead.new",
          recipient: { userId },
          channels: ["IN_APP"],
          data: {
            lead: leadName(lead),
            via: data.via === "FORM" ? "the website form" : "the website",
            due: due.toLocaleTimeString("en-IN", {
              timeZone: tenant.timezone,
              timeStyle: "short",
            }),
          },
          link: `/leads/${lead.id}`,
          dedupeKey: `lead-new:${lead.id}:${userId}`,
        });
    },
  },
  {
    name: "crm.notify-sla-breach",
    types: ["lead.uncontacted_sla_breached"],
    async handle(tx, tenantId, event) {
      const data = event.data as {
        leadId: string;
        ownerUserId: string | null;
        minutes: number;
      };
      const lead = await tx.lead.findUnique({ where: { id: data.leadId } });
      if (!lead || lead.firstContactedAt) return;
      const managers = await crmStaff(tx, lead.branchId, [
        "BRANCH_MANAGER",
        "GYM_ADMIN",
      ]);
      const recipients = new Set([
        ...(data.ownerUserId ? [data.ownerUserId] : []),
        ...managers.map((m) => m.userId),
      ]);
      for (const userId of recipients)
        await notify(tx, tenantId, {
          templateKey: "lead.sla_breached",
          recipient: { userId },
          channels: ["IN_APP"],
          data: { lead: leadName(lead), minutes: data.minutes },
          link: `/leads/${lead.id}`,
          dedupeKey: `lead-sla:${lead.id}:${userId}`,
        });
    },
  },
];
