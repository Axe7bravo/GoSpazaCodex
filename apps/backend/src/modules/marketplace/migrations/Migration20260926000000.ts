import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20260926000000 extends Migration {
  async up(): Promise<void> {
    this.addSql('alter table "merchant_application" add column "last_submitted_at" timestamptz null;');
    this.addSql('update "merchant_application" set "last_submitted_at" = "submitted_at";');
    this.addSql(`create table "merchant" (
      "id" text primary key, "source_application_id" text not null unique references "merchant_application"("id") on delete restrict,
      "legal_name" text not null, "trading_name" text not null,
      "status" text not null default 'ACTIVE' check ("status" in ('ACTIVE','SUSPENDED')),
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null
    );`);
    this.addSql(`create table "merchant_store" (
      "id" text primary key, "merchant_id" text not null unique references "merchant"("id") on delete restrict,
      "name" text not null, "address_line_1" text not null, "address_line_2" text not null, "city" text not null,
      "province" text not null, "postal_code" text not null, "country_code" text not null, "medusa_stock_location_id" text null,
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null
    );`);
    this.addSql(`create table "merchant_member" (
      "id" text primary key, "merchant_id" text not null unique references "merchant"("id") on delete restrict,
      "auth_identity_id" text not null unique, "member_type" text not null default 'OWNER' check ("member_type" = 'OWNER'),
      "status" text not null default 'ACTIVE' check ("status" in ('ACTIVE','INACTIVE')),
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null
    );`);
    this.addSql(`create table "merchant_application_review" (
      "id" text primary key, "application_id" text not null references "merchant_application"("id") on delete cascade,
      "action" text not null check ("action" in ('REVIEW_STARTED','INFORMATION_REQUESTED','RESUBMITTED','REJECTED','APPROVED')),
      "platform_user_id" text null, "reason" text not null default '', "from_status" text not null, "to_status" text not null,
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null,
      constraint "review_actor" check (("action" = 'RESUBMITTED' and "platform_user_id" is null) or ("action" <> 'RESUBMITTED' and "platform_user_id" is not null)),
      constraint "review_reason" check ("action" not in ('INFORMATION_REQUESTED','REJECTED','APPROVED') or length(trim("reason")) > 0)
    );`);
    this.addSql('create index "IDX_review_application" on "merchant_application_review" ("application_id", "created_at");');
    this.addSql(`create unique index "IDX_review_approval_once" on "merchant_application_review" ("application_id") where "action" = 'APPROVED';`);
    this.addSql(`create function gospaza_immutable_review() returns trigger language plpgsql as $$ begin raise exception 'Review history cannot be rewritten'; end; $$;`);
    this.addSql('create trigger immutable_review before update on "merchant_application_review" for each row execute function gospaza_immutable_review();');
  }
  async down(): Promise<void> {
    this.addSql('drop table "merchant_application_review";'); this.addSql('drop function gospaza_immutable_review();');
    this.addSql('drop table "merchant_member";'); this.addSql('drop table "merchant_store";'); this.addSql('drop table "merchant";');
    this.addSql('alter table "merchant_application" drop column "last_submitted_at";');
  }
}
