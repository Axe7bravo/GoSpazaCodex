import type { ExecArgs } from "@medusajs/framework/types";
import { CommissionService } from "../lib/commission-service";

// One bounded internal provisioning page. The operator can resume using the
// printed keyset cursor. Concurrent invocations converge under Order locks.
export default async function provisionOrderFinance({ container }: ExecArgs) {
  const result = await new CommissionService(container).provisionPage(process.env.M19_PROVISION_AFTER);
  console.log("M19 snapshot provisioning:", JSON.stringify(result));
  if (result.deferred.length) throw new Error("Some M19 snapshots require another provisioning sweep.");
}
