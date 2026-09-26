import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20260927000000 extends Migration {
  async up(): Promise<void> {
    this.addSql('alter table "merchant_member" drop constraint "merchant_member_merchant_id_key";');
    this.addSql('alter table "merchant_member" drop constraint "merchant_member_member_type_check";');
    this.addSql(`alter table "merchant_member" add constraint "merchant_member_member_type_check" check ("member_type" in ('OWNER','MANAGER','PICKER'));`);
    this.addSql(`create unique index "IDX_merchant_owner" on "merchant_member" ("merchant_id") where "member_type" = 'OWNER';`);
    this.addSql('create index "IDX_member_merchant" on "merchant_member" ("merchant_id");');
    this.addSql(`create table "merchant_invitation" (
      "id" text primary key, "merchant_id" text not null references "merchant"("id") on delete restrict,
      "email_normalized" text not null check ("email_normalized" = lower(trim("email_normalized"))),
      "role" text not null check ("role" in ('MANAGER','PICKER')), "token_hash" text not null unique,
      "expires_at" timestamptz not null, "accepted_at" timestamptz null, "revoked_at" timestamptz null, "closed_at" timestamptz null,
      "created_by_member_id" text not null references "merchant_member"("id") on delete restrict,
      "accepted_by_identity_id" text null,
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null,
      constraint "invitation_terminal_state" check (not ("accepted_at" is not null and "revoked_at" is not null)),
      constraint "invitation_acceptance" check (("accepted_at" is null) = ("accepted_by_identity_id" is null)),
      constraint "invitation_closed" check (("accepted_at" is null and "revoked_at" is null) or "closed_at" is not null)
    );`);
    this.addSql('create unique index "IDX_pending_invitation" on "merchant_invitation" ("merchant_id", "email_normalized") where "closed_at" is null;');
  }
  async down(): Promise<void> {
    // Refuse a data-losing rollback before dropping anything.
    this.addSql(`do $$ begin
      if exists (select 1 from "merchant_invitation") or exists (select 1 from "merchant_member" where "member_type" <> 'OWNER') then
        raise exception 'M4 contains team data; rollback requires an explicit data migration';
      end if;
    end $$;`);
    this.addSql('drop table "merchant_invitation";');
    this.addSql('drop index "IDX_merchant_owner";');
    this.addSql('drop index "IDX_member_merchant";');
    this.addSql('alter table "merchant_member" drop constraint "merchant_member_member_type_check";');
    this.addSql(`alter table "merchant_member" add constraint "merchant_member_member_type_check" check ("member_type" = 'OWNER');`);
    this.addSql('alter table "merchant_member" add constraint "merchant_member_merchant_id_key" unique ("merchant_id");');
  }
}
