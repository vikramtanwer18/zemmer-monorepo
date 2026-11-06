/** Writes docs/PERMISSIONS.md from the permission matrix. Run: pnpm docs:permissions */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { renderPermissionsDoc } from "../src/permissions-doc";

const target = path.resolve(
  import.meta.dirname,
  "../../../docs/PERMISSIONS.md",
);
writeFileSync(target, renderPermissionsDoc());
console.log(`Wrote ${path.relative(process.cwd(), target)}`);
