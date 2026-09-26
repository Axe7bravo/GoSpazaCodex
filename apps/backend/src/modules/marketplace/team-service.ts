import { randomUUID } from "node:crypto";
import { MedusaError } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import {
  acceptInput, invitationSecret, invitationState, inviteInput, invitationLifetimeMs,
  memberInput, normalizeEmail, requireCapability, teamParse, tokenHash,
} from "./team-policy";
import type { Capability, MemberRole } from "./team-policy";

type Context = { merchant: { id: string }; membership: { id: string; member_type: MemberRole } };
interface MemberRow {
  id: string;
  merchant_id: string;
  auth_identity_id: string;
  member_type: MemberRole;
  status: "ACTIVE" | "INACTIVE";
  created_at: Date;
}
interface InvitationRow {
  id: string;
  merchant_id: string;
  email_normalized: string;
  role: "MANAGER" | "PICKER";
  token_hash: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  closed_at: Date | null;
  created_by_member_id: string;
  created_at: Date;
}
const memberDTO = (row: MemberRow) => ({
  id: row.id, role: row.member_type, status: row.status, created_at: row.created_at,
});
const invitationDTO = (row: InvitationRow) => ({
  id: row.id, email: row.email_normalized, role: row.role,
  state: invitationState(row), expires_at: row.expires_at, created_at: row.created_at,
});
const conflict = (message: string) => new MedusaError(MedusaError.Types.CONFLICT, message);
const invalidInvitation = () => conflict("Invitation cannot be accepted. Check the invited account or ask the owner for a new link.");

export class MerchantTeamService {
  constructor(
    private db: Knex,
    private resolve: (identity: string, db?: Knex | Knex.Transaction) => Promise<Context>,
  ) {}

  private async authorized<T>(
    identity: string,
    capability: Capability,
    work: (trx: Knex.Transaction, context: Context) => Promise<T>,
  ): Promise<T> {
    const initial = await this.resolve(identity);
    return this.db.transaction(async (trx) => {
      // All team operations use merchant -> invitation/member lock order.
      // Recheck tenancy and capabilities after waiting, so a stale request cannot
      // act with permissions removed by a preceding owner mutation.
      await trx("merchant").where({ id: initial.merchant.id }).forUpdate().first();
      const context = await this.resolve(identity, trx);
      if (context.merchant.id !== initial.merchant.id) {
        throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Merchant context changed.");
      }
      requireCapability(context.membership.member_type, capability);
      return work(trx, context);
    });
  }

  async listMembers(identity: string) {
    return this.authorized(identity, "MERCHANT_TEAM_VIEW", async (trx, context) => {
      const rows = await trx<MemberRow>("merchant_member")
        .where({ merchant_id: context.merchant.id }).whereNull("deleted_at")
        .orderBy("created_at").orderBy("id");
      return { members: rows.map(memberDTO) };
    });
  }

  async listInvitations(identity: string) {
    return this.authorized(identity, "MERCHANT_TEAM_VIEW", async (trx, context) => {
      const rows = await trx<InvitationRow>("merchant_invitation")
        .where({ merchant_id: context.merchant.id }).whereNull("deleted_at")
        .orderBy("created_at", "desc").orderBy("id");
      return { invitations: rows.map(invitationDTO) };
    });
  }

  async invite(identity: string, input: unknown, emailFor: (id: string) => Promise<string>) {
    const data = teamParse(inviteInput, input);
    const lifetime = invitationLifetimeMs();
    return this.authorized(identity, "MERCHANT_TEAM_MANAGE", async (trx, context) => {
      const members = await trx<MemberRow>("merchant_member")
        .where({ merchant_id: context.merchant.id, status: "ACTIVE" }).whereNull("deleted_at");
      for (const member of members) {
        const email = await emailFor(member.auth_identity_id);
        if (normalizeEmail(email) === data.email) {
          throw conflict("This email already belongs to an active team member.");
        }
      }
      const now = new Date();
      // Retire expired pending records without changing their derived EXPIRED state.
      // The partial unique index guards the remaining pending merchant/email pair.
      await trx("merchant_invitation")
        .where({ merchant_id: context.merchant.id, email_normalized: data.email })
        .whereNull("closed_at").where("expires_at", "<=", now)
        .update({ closed_at: now, updated_at: now });
      const pending = await trx("merchant_invitation")
        .where({ merchant_id: context.merchant.id, email_normalized: data.email })
        .whereNull("closed_at").first();
      if (pending) throw conflict("A pending invitation already exists. Revoke it before issuing another.");
      const secret = invitationSecret();
      const [row] = await trx<InvitationRow>("merchant_invitation").insert({
        id: "minv_" + randomUUID(), merchant_id: context.merchant.id,
        email_normalized: data.email, role: data.role, token_hash: secret.hash,
        expires_at: new Date(now.getTime() + lifetime), created_by_member_id: context.membership.id,
      }).returning("*");
      if (!row) throw new Error("Invitation insert failed.");
      // Raw secret is returned once, only after the transaction commits.
      return { invitation: invitationDTO(row), token: secret.token };
    });
  }

  async revoke(identity: string, id: string) {
    return this.authorized(identity, "MERCHANT_TEAM_MANAGE", async (trx, context) => {
      const row = await trx<InvitationRow>("merchant_invitation")
        .where({ id, merchant_id: context.merchant.id }).whereNull("deleted_at").forUpdate().first();
      if (!row) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Invitation not found.");
      if (row.revoked_at) return { invitation: invitationDTO(row) };
      if (invitationState(row) !== "PENDING") throw conflict("Only pending invitations can be revoked.");
      const now = new Date();
      await trx("merchant_invitation").where({ id }).update({ revoked_at: now, closed_at: now, updated_at: now });
      return { invitation: invitationDTO({ ...row, revoked_at: now }) };
    });
  }

  async changeMember(identity: string, id: string, input: unknown) {
    const data = teamParse(memberInput, input);
    return this.authorized(identity, "MERCHANT_TEAM_MANAGE", async (trx, context) => {
      const row = await trx<MemberRow>("merchant_member")
        .where({ id, merchant_id: context.merchant.id }).whereNull("deleted_at").forUpdate().first();
      if (!row) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Member not found.");
      if (row.member_type === "OWNER") {
        throw new MedusaError(MedusaError.Types.FORBIDDEN, "Owner membership cannot be changed.");
      }
      const next = { member_type: data.role ?? row.member_type, status: data.status ?? row.status };
      await trx("merchant_member").where({ id }).update({ ...next, updated_at: new Date() });
      return { member: memberDTO({ ...row, ...next }) };
    });
  }

  async accept(identity: string, email: string, input: unknown) {
    if (!identity || !email) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Merchant identity required.");
    const { token } = teamParse(acceptInput, input);
    const hash = tokenHash(token);
    const initial = await this.db<InvitationRow>("merchant_invitation")
      .where({ token_hash: hash }).whereNull("deleted_at").first();
    if (!initial) throw invalidInvitation();
    try {
      return await this.db.transaction(async (trx) => {
        const merchant = await trx("merchant")
          .where({ id: initial.merchant_id, status: "ACTIVE" }).whereNull("deleted_at").forUpdate().first();
        const row = await trx<InvitationRow>("merchant_invitation")
          .where({ id: initial.id, token_hash: hash }).whereNull("deleted_at").forUpdate().first();
        if (!merchant || !row || row.closed_at || invitationState(row) !== "PENDING" || row.email_normalized !== normalizeEmail(email)) {
          throw invalidInvitation();
        }
        // Preserve M3's stronger global uniqueness, including inactive membership.
        if (await trx("merchant_member").where({ auth_identity_id: identity }).first()) {
          throw conflict("This account already has a membership. Ask its owner to reactivate it if needed.");
        }
        const memberId = "mmem_" + randomUUID();
        const now = new Date();
        await trx("merchant_member").insert({
          id: memberId, merchant_id: row.merchant_id, auth_identity_id: identity,
          member_type: row.role, status: "ACTIVE",
        });
        await trx("merchant_invitation").where({ id: row.id }).update({
          accepted_at: now, accepted_by_identity_id: identity, closed_at: now, updated_at: now,
        });
        // Roll back both writes if the merchant/store/application chain is invalid.
        await this.resolve(identity, trx);
        return { member_id: memberId };
      });
    } catch (error) {
      // Different merchants use different row locks. The global identity constraint
      // resolves concurrent cross-merchant accepts, with a safe conflict response.
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw conflict("This account already has a membership.");
      }
      throw error;
    }
  }
}
