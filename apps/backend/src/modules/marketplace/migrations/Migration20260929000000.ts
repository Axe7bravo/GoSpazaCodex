import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260929000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table merchant_store
        add column active boolean not null default true,
        add column medusa_fulfillment_set_id text null;
      create unique index merchant_store_fulfillment_unique
        on merchant_store(medusa_fulfillment_set_id)
        where medusa_fulfillment_set_id is not null;
    `);
    this.addSql(`
      create table marketplace_service_zone (
        id text primary key,
        name text not null,
        active boolean not null default true,
        geometry jsonb not null,
        delivery_fee_minor integer not null check(delivery_fee_minor >= 0),
        currency_code text not null default 'zar' check(currency_code = 'zar'),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz null
      );
      create table merchant_store_service_zone (
        id text primary key,
        merchant_store_id text not null references merchant_store(id) on delete restrict,
        service_zone_id text not null references marketplace_service_zone(id) on delete restrict,
        active boolean not null default false,
        medusa_service_zone_id text unique,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz null,
        unique(merchant_store_id, service_zone_id),
        check(not active or medusa_service_zone_id is not null)
      );
      create table service_zone_event (
        id text primary key,
        service_zone_id text not null references marketplace_service_zone(id) on delete restrict,
        platform_user_id text not null,
        action text not null check(action in ('CREATED', 'UPDATED', 'STORE_ASSIGNED', 'STORE_UNASSIGNED')),
        before_state jsonb null,
        after_state jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz null
      );
      create trigger immutable_service_zone_event before update on service_zone_event
        for each row execute function gospaza_immutable_review();
      create table customer_address_location (
        id text primary key,
        medusa_customer_address_id text not null unique,
        latitude double precision not null check(latitude between -90 and 90),
        longitude double precision not null check(longitude between -180 and 180),
        source text not null check(source in ('browser_geolocation', 'manual')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz null
      );
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      do $$ begin
        if exists(select 1 from marketplace_service_zone)
          or exists(select 1 from customer_address_location)
          or exists(select 1 from merchant_store where medusa_fulfillment_set_id is not null) then
          raise exception 'M6 data exists; explicit data migration required';
        end if;
      end $$;
    `);
    this.addSql(`
      drop table service_zone_event;
      drop table customer_address_location;
      drop table merchant_store_service_zone;
      drop table marketplace_service_zone;
      alter table merchant_store drop column medusa_fulfillment_set_id, drop column active;
    `);
  }
}
