import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExecArgs, IUserModuleService, IAuthModuleService } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { commissionActorFile, commissionFixturePassword } from "./fixtures/commission-actors";

export default async function prepareCommissionActors({ container }: ExecArgs) {
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  async function actor() {
    const email = randomUUID() + "@example.test";
    const registration = await auth.register("emailpass", { body: { email, password: commissionFixturePassword(email) } });
    assert.ok(registration.authIdentity);
    const user = await users.createUsers({ email });
    await auth.updateAuthIdentities({ id: registration.authIdentity.id, app_metadata: { user_id: user.id } });
    return { id: user.id, email };
  }
  const writer = await actor(), viewer = await actor();
  await mkdir(dirname(commissionActorFile), { recursive: true });
  await writeFile(commissionActorFile, JSON.stringify({ writer, viewer }));
  console.log("M19 test actor IDs ready in " + commissionActorFile);
}
