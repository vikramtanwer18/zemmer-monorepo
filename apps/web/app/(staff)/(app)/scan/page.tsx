import { listScanBranches, listScanDevices } from "@gym/core/attendance";
import { hasPermission } from "@gym/core/authz";
import { PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { ScanStation } from "./scan-station";

export const metadata: Metadata = { title: "Scan" };

export default async function ScanPage() {
  const { ctx, session } = await requireReady("/scan");
  if (!hasPermission(ctx, "attendance.scan")) return <NoAccess />;
  const { deps } = services();
  const branches = await listScanBranches(deps, ctx);
  const devices = await listScanDevices(deps, ctx);
  const defaultBranch =
    branches.find((b) => b.id === session.activeBranchId)?.id ??
    branches[0]?.id ??
    "";
  return (
    <>
      <PageHeader
        title="Scan member passes"
        description="Point the camera at the member's card, or use a USB/Bluetooth scanner. Codes change every 30 seconds and work once."
      />
      {branches.length === 0 ? (
        <NoAccess />
      ) : (
        <ScanStation
          branches={branches}
          defaultBranchId={defaultBranch}
          devices={devices.map((d) => ({
            id: d.id,
            name: d.name,
            branchId: d.branchId,
          }))}
          canOverride={hasPermission(ctx, "attendance.override")}
        />
      )}
    </>
  );
}
