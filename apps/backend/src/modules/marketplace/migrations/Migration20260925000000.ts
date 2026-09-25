import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20260925000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`create table "merchant_application" (
      "id" text primary key, "applicant_identity_id" text not null unique,
      "legal_name" text not null default '', "trading_name" text not null default '',
      "contact_name" text not null default '', "contact_email" text not null default '', "contact_phone" text not null default '',
      "address_line_1" text not null default '', "address_line_2" text not null default '',
      "city" text not null default '', "province" text not null default '', "postal_code" text not null default '', "country_code" text not null default 'ZA',
      "intends_to_sell_alcohol" boolean not null default false, "notes" text not null default '',
      "status" text not null default 'DRAFT' check ("status" in ('DRAFT','SUBMITTED','UNDER_REVIEW','MORE_INFORMATION_REQUIRED','APPROVED','REJECTED')),
      "submitted_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null,
      constraint "application_submission_timestamp" check (("status" = 'DRAFT' and "submitted_at" is null) or ("status" <> 'DRAFT' and "submitted_at" is not null))
    );`);
    this.addSql(`create index "IDX_merchant_application_status" on "merchant_application" ("status", "submitted_at");`);
    this.addSql(`create table "merchant_application_document" (
      "id" text primary key, "application_id" text not null references "merchant_application"("id") on delete cascade,
      "document_type" text not null check ("document_type" in ('BUSINESS_REGISTRATION','REPRESENTATIVE_ID','LIQUOR_DOCUMENT','OTHER')),
      "display_name" text not null, "storage_key" text not null unique,
      "mime_type" text not null check ("mime_type" in ('application/pdf','image/jpeg','image/png')),
      "size_bytes" integer not null check ("size_bytes" > 0 and "size_bytes" <= 10485760), "removal_pending" boolean not null default false,
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null
    );`);
    this.addSql(`create index "IDX_application_document_application" on "merchant_application_document" ("application_id");`);
    this.addSql(`create function gospaza_preserve_application_submission() returns trigger language plpgsql as $$
      begin
        if old.submitted_at is not null and (new.submitted_at is distinct from old.submitted_at or new.status = 'DRAFT') then
          raise exception 'Application submission cannot be reset';
        end if;
        return new;
      end; $$;`);
    this.addSql(`create trigger preserve_application_submission before update on "merchant_application" for each row execute function gospaza_preserve_application_submission();`);
  }
  async down(): Promise<void> {
    this.addSql('drop table if exists "merchant_application_document";');
    this.addSql('drop table if exists "merchant_application";');
    this.addSql('drop function if exists gospaza_preserve_application_submission();');
  }
}
