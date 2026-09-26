import { createHash, randomBytes } from "node:crypto";
import { MedusaError } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
export type MemberRole = "OWNER" | "MANAGER" | "PICKER";
export type Capability = "MERCHANT_PORTAL_ACCESS" | "MERCHANT_CONTEXT_VIEW" | "MERCHANT_TEAM_VIEW" | "MERCHANT_TEAM_MANAGE";
const capabilities: Record<MemberRole, readonly Capability[]> = {
  OWNER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_TEAM_VIEW", "MERCHANT_TEAM_MANAGE"],
  MANAGER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_TEAM_VIEW"],
  PICKER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW"],
};
export const capabilitiesFor = (role: MemberRole): Capability[] => [...(capabilities[role] ?? [])];
export function requireCapability(role: MemberRole, capability: Capability) {
  if (!capabilitiesFor(role).includes(capability)) {
    throw new MedusaError(MedusaError.Types.FORBIDDEN, "Merchant capability required.");
  }
}
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const inviteInput = z.object({
  email: z.string().trim().email().max(254).transform(normalizeEmail),
  role: z.enum(["MANAGER", "PICKER"]),
}).strict();
export const memberInput = z.object({
  role: z.enum(["MANAGER", "PICKER"]).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).strict().refine((value) => value.role !== undefined || value.status !== undefined);
export const acceptInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const emptyInput = z.object({}).strict();
export const resourceId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const DEFAULT_INVITATION_EXPIRY_DAYS = 7;
export function invitationLifetimeMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.MERCHANT_INVITATION_EXPIRY_DAYS;
  const days = raw === undefined ? DEFAULT_INVITATION_EXPIRY_DAYS : Number(raw);
  if ((raw !== undefined && !/^[0-9]+$/.test(raw)) || !Number.isInteger(days) || days < 1 || days > 30) {
    throw new Error("MERCHANT_INVITATION_EXPIRY_DAYS must be an integer from 1 to 30.");
  }
  return days * 24 * 60 * 60 * 1000;
}
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function invitationSecret() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: tokenHash(token) };
}
export function invitationState(row: { accepted_at: Date | string | null; revoked_at: Date | string | null; expires_at: Date | string }, now = new Date()) {
  if (row.accepted_at) return "ACCEPTED" as const;
  if (row.revoked_at) return "REVOKED" as const;
  return new Date(row.expires_at) <= now ? "EXPIRED" as const : "PENDING" as const;
}
export function teamParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid team input.");
  return result.data;
}
