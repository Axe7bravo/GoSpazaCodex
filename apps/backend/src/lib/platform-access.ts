import { Modules, MedusaError } from "@medusajs/framework/utils";
import type { IAuthModuleService, IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { requirePlatformGrant, type PlatformCapability } from "../modules/marketplace/platform-capabilities";

export async function platformAccess(container: MedusaContainer, actor: string, ...capabilities: PlatformCapability[]) {
  requirePlatformGrant(actor, ...capabilities);
  await container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor);
  requirePlatformGrant(actor, ...capabilities);
}
// Used by the new HTTP read boundary; a surviving cookie is not sufficient
// after native identity deletion, nor can metadata supply platform grants.
export async function currentPlatform(container: MedusaContainer, context: { actor_type?: string; actor_id?: string; auth_identity_id?: string } | undefined) {
  if (context?.actor_type !== "user" || !context.actor_id || !context.auth_identity_id)
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Platform authentication required.");
  const identity = await container.resolve<IAuthModuleService>(Modules.AUTH).retrieveAuthIdentity(context.auth_identity_id);
  if (identity.app_metadata?.user_id !== context.actor_id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Platform authentication required.");
  await container.resolve<IUserModuleService>(Modules.USER).retrieveUser(context.actor_id);
  return context.actor_id;
}
