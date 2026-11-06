import { MedusaError } from "@medusajs/framework/utils";

export const platformCapabilities = ["ORDER_OPERATIONS_VIEW", "DELIVERY_OPERATIONS_VIEW", "DELIVERY_RESCUE", "MERCHANT_REVIEW_VIEW",
  "MERCHANT_REVIEW_MANAGE", "MERCHANT_DOCUMENT_VIEW", "DRIVER_REVIEW_VIEW", "DRIVER_REVIEW_MANAGE", "SERVICE_CONFIGURATION_VIEW", "SERVICE_CONFIGURATION_MANAGE"] as const;
export type PlatformCapability = typeof platformCapabilities[number];
export function platformGranted(actor: string, capability: PlatformCapability, env: NodeJS.ProcessEnv = process.env) {
  return !!actor && (env[capability + "_USER_IDS"] ?? "").split(",").map(value => value.trim()).filter(Boolean).includes(actor);
}
export function requirePlatformGrant(actor: string, ...capabilities: PlatformCapability[]) {
  if (!actor || !capabilities.every(capability => platformGranted(actor, capability)))
    throw new MedusaError(MedusaError.Types.FORBIDDEN, "Platform capability required.");
}
export const legacyCapabilities = {
  merchantRead: ["MERCHANT_REVIEW_VIEW"], merchantWrite: ["MERCHANT_REVIEW_VIEW", "MERCHANT_REVIEW_MANAGE"],
  merchantDocument: ["MERCHANT_REVIEW_VIEW", "MERCHANT_DOCUMENT_VIEW"], driverRead: ["DRIVER_REVIEW_VIEW"],
  driverWrite: ["DRIVER_REVIEW_VIEW", "DRIVER_REVIEW_MANAGE"], configurationRead: ["SERVICE_CONFIGURATION_VIEW"],
  configurationWrite: ["SERVICE_CONFIGURATION_VIEW", "SERVICE_CONFIGURATION_MANAGE"],
} as const satisfies Record<string, readonly PlatformCapability[]>;
