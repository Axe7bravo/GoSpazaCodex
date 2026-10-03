import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20260928000000 extends Migration {
  async up(): Promise<void> {
    this.addSql('alter table merchant add column medusa_sales_channel_id text null;');
    this.addSql('create unique index merchant_sales_channel_unique on merchant (medusa_sales_channel_id) where medusa_sales_channel_id is not null;');
    this.addSql('create unique index merchant_store_stock_location_unique on merchant_store (medusa_stock_location_id) where medusa_stock_location_id is not null;');
    this.addSql(`create table product_marketplace_profile (
      id text primary key, merchant_id text not null references merchant(id) on delete restrict,
      medusa_product_id text not null unique, requires_age_verification boolean not null default false,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz null
    );`);
    this.addSql('create index IDX_profile_merchant on product_marketplace_profile(merchant_id);');
    this.addSql(`create table catalogue_media (
      id text primary key, profile_id text not null references product_marketplace_profile(id) on delete restrict,
      file_key text not null unique, public_url text not null unique, removal_pending boolean not null default false,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz null
    );`);
  }
  async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists(select 1 from product_marketplace_profile) or exists(select 1 from merchant where medusa_sales_channel_id is not null) then
        raise exception 'M5 commerce data exists; explicit data migration required';
      end if;
    end $$;`);
    this.addSql('drop table catalogue_media; drop table product_marketplace_profile;');
    this.addSql('drop index merchant_store_stock_location_unique;');
    this.addSql('drop index merchant_sales_channel_unique;');
    this.addSql('alter table merchant drop column medusa_sales_channel_id;');
  }
}
