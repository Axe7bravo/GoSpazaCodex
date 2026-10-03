import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260930100000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table merchant_store_service_zone add column priority integer not null default 0;
      alter table merchant_store_service_zone add constraint assignment_store_unique unique(id, merchant_store_id);
      alter table cart_marketplace_context add constraint context_store_unique unique(id, merchant_store_id);
      create table store_delivery_policy (
        id text primary key, merchant_store_id text not null unique references merchant_store(id),
        timezone text not null default 'Africa/Johannesburg',
        asap_enabled boolean not null default false, scheduled_enabled boolean not null default false,
        minimum_lead_minutes integer not null default 60 check(minimum_lead_minutes between 0 and 10080),
        booking_horizon_days integer not null default 7 check(booking_horizon_days between 1 and 90),
        hold_minutes integer not null default 15 check(hold_minutes between 1 and 1440),
        enabled boolean not null default false, revision integer not null default 1 check(revision > 0),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
      );
      create table delivery_option_configuration (
        id text primary key, merchant_store_id text not null,
        store_service_zone_id text not null, mode text not null check(mode in ('ASAP','SCHEDULED')),
        enabled boolean not null default false, medusa_shipping_option_id text,
        revision integer not null default 1 check(revision > 0), synced_revision integer,
        sync_state text not null default 'PENDING' check(sync_state in ('PENDING','SYNCING','READY','FAILED')),
        sync_error text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        unique(store_service_zone_id, mode), unique(id, merchant_store_id, store_service_zone_id),
        foreign key(store_service_zone_id, merchant_store_id) references merchant_store_service_zone(id, merchant_store_id),
        check(synced_revision is null or synced_revision > 0 and synced_revision <= revision),
        check(sync_state <> 'READY' or (synced_revision is not null and synced_revision = revision and medusa_shipping_option_id is not null))
      );
      create unique index delivery_native_option_unique on delivery_option_configuration(medusa_shipping_option_id)
        where medusa_shipping_option_id is not null;
      create table delivery_slot (
        id text primary key, merchant_store_id text not null references merchant_store(id),
        start_at timestamptz not null, end_at timestamptz not null, booking_cutoff_at timestamptz not null,
        capacity integer not null check(capacity > 0), enabled boolean not null default true,
        revision integer not null default 1 check(revision > 0),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        unique(id, merchant_store_id), unique(merchant_store_id, start_at, end_at),
        check(start_at < end_at), check(booking_cutoff_at <= start_at)
      );
      create index delivery_slot_availability on delivery_slot(merchant_store_id, enabled, start_at);
      create table delivery_reservation (
        id text primary key, cart_context_id text not null, merchant_store_id text not null,
        delivery_option_id text not null, store_service_zone_id text not null, delivery_slot_id text not null,
        status text not null default 'HELD' check(status in ('HELD','RELEASED','EXPIRED')),
        expires_at timestamptz not null, released_at timestamptz, release_reason text,
        configuration_revision integer not null check(configuration_revision > 0),
        selection_revision integer not null default 1 check(selection_revision > 0),
        quoted_fee_minor integer not null check(quoted_fee_minor >= 0), currency_code text not null default 'zar' check(currency_code = 'zar'),
        medusa_customer_address_id text, latitude double precision, longitude double precision,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        foreign key(cart_context_id, merchant_store_id) references cart_marketplace_context(id, merchant_store_id),
        foreign key(delivery_option_id, merchant_store_id, store_service_zone_id)
          references delivery_option_configuration(id, merchant_store_id, store_service_zone_id),
        foreign key(delivery_slot_id, merchant_store_id) references delivery_slot(id, merchant_store_id),
        check(expires_at > created_at),
        check((latitude is null) = (longitude is null)),
        check(latitude between -90 and 90 and longitude between -180 and 180),
        check(medusa_customer_address_id is not null or latitude is not null),
        check(status <> 'HELD' or released_at is null)
      );
      create unique index delivery_one_held_per_cart on delivery_reservation(cart_context_id) where status = 'HELD';
      create index delivery_slot_holds on delivery_reservation(delivery_slot_id, status, expires_at);
      create index delivery_expiry on delivery_reservation(status, expires_at);
      create table scheduling_event (
        id text primary key, platform_user_id text not null, target_id text not null,
        action text not null, reason text not null, before_state jsonb, after_state jsonb not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
      );
      create trigger immutable_scheduling_event before update on scheduling_event
        for each row execute function gospaza_immutable_review();
    `);
    // Invalidation also covers the existing M6 tariff/assignment operations. Native
    // writes cannot falsely publish READY after a concurrent Marketplace change.
    this.addSql(`
      create function gospaza_invalidate_delivery_options() returns trigger language plpgsql as $$ begin
        if tg_table_name = 'marketplace_service_zone' then
          update delivery_option_configuration set revision = revision + 1, sync_state = 'PENDING', sync_error = null, updated_at = now()
            where store_service_zone_id in (select id from merchant_store_service_zone where service_zone_id = new.id);
        elsif tg_table_name = 'merchant_store_service_zone' then
          update delivery_option_configuration set revision = revision + 1, sync_state = 'PENDING', sync_error = null, updated_at = now()
            where store_service_zone_id = new.id;
        else
          update delivery_option_configuration set revision = revision + 1, sync_state = 'PENDING', sync_error = null, updated_at = now()
            where merchant_store_id = new.merchant_store_id;
        end if;
        return new;
      end; $$;
      create trigger delivery_zone_changed after update on marketplace_service_zone for each row
        when (old.delivery_fee_minor is distinct from new.delivery_fee_minor or old.active is distinct from new.active
          or old.geometry is distinct from new.geometry or old.deleted_at is distinct from new.deleted_at)
        execute function gospaza_invalidate_delivery_options();
      create trigger delivery_assignment_changed after update on merchant_store_service_zone for each row
        when (old.priority is distinct from new.priority or old.active is distinct from new.active
          or old.medusa_service_zone_id is distinct from new.medusa_service_zone_id or old.deleted_at is distinct from new.deleted_at)
        execute function gospaza_invalidate_delivery_options();
      create trigger delivery_policy_changed after update on store_delivery_policy for each row
        when (old.revision is distinct from new.revision or old.deleted_at is distinct from new.deleted_at
          or old.enabled is distinct from new.enabled or old.timezone is distinct from new.timezone
          or old.asap_enabled is distinct from new.asap_enabled or old.scheduled_enabled is distinct from new.scheduled_enabled
          or old.minimum_lead_minutes is distinct from new.minimum_lead_minutes
          or old.booking_horizon_days is distinct from new.booking_horizon_days or old.hold_minutes is distinct from new.hold_minutes)
        execute function gospaza_invalidate_delivery_options();
    `);
  }

  async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists(select 1 from store_delivery_policy) or exists(select 1 from delivery_option_configuration)
        or exists(select 1 from delivery_slot) or exists(select 1 from delivery_reservation)
        or exists(select 1 from scheduling_event) then
        raise exception 'Scheduling data exists; explicit data migration required';
      end if;
    end $$;`);
    this.addSql(`
      drop trigger delivery_zone_changed on marketplace_service_zone;
      drop trigger delivery_assignment_changed on merchant_store_service_zone;
      drop trigger delivery_policy_changed on store_delivery_policy;
      drop function gospaza_invalidate_delivery_options();
      drop table scheduling_event, delivery_reservation, delivery_slot, delivery_option_configuration, store_delivery_policy;
      alter table merchant_store_service_zone drop constraint assignment_store_unique, drop column priority;
      alter table cart_marketplace_context drop constraint context_store_unique;
    `);
  }
}
