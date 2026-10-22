import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20261019000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table store_dispatch_configuration (
        id text primary key, merchant_store_id text not null unique references merchant_store(id),
        mode text not null default 'DISABLED' check(mode in ('DISABLED','MERCHANT_ONLY','PLATFORM_ONLY','HYBRID')),
        revision integer not null default 1 check(revision>0),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null)
      );
      create table driver_availability (
        id text primary key, driver_profile_id text not null unique references driver_profile(id),
        intent text not null default 'OFFLINE' check(intent in ('OFFLINE','ONLINE')), revision integer not null default 1 check(revision>0),
        generation text, available_since timestamptz, profile_revision integer, affiliation_id text references driver_affiliation(id), affiliation_revision integer,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        check(intent='OFFLINE' or (generation is not null and available_since is not null and profile_revision is not null and affiliation_id is not null and affiliation_revision is not null))
      );
      create table delivery_operation (
        id text primary key, order_operation_id text not null unique references order_operation(id),
        medusa_order_id text not null unique, merchant_id text not null references merchant(id), merchant_store_id text not null,
        pick_session_id text not null references pick_session(id), reservation_id text not null references delivery_reservation(id),
        service_zone_id text not null references marketplace_service_zone(id),
        status text not null default 'PENDING_DISPATCH' check(status in ('PENDING_DISPATCH','SEARCHING','OFFERED','ASSIGNED','ATTENTION_REQUIRED')),
        revision integer not null default 1 check(revision>0), generation integer not null default 0 check(generation in (0,1)),
        mode text not null default 'DISABLED' check(mode in ('DISABLED','MERCHANT_ONLY','PLATFORM_ONLY','HYBRID')), configuration_revision integer not null default 0,
        path text check(path in ('MERCHANT','PLATFORM')), started_at timestamptz, deadline timestamptz, merchant_deadline timestamptz,
        dispatch_not_before timestamptz, offer_ms integer check(offer_ms>0), restricted_content_present boolean not null default false, reason text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        foreign key(merchant_store_id,merchant_id) references merchant_store(id,merchant_id),
        check((status='PENDING_DISPATCH' and generation=0) or (status<>'PENDING_DISPATCH' and generation=1)),
        check(generation=0 or (started_at is not null and deadline>started_at and path is not null and mode<>'DISABLED' and offer_ms is not null))
      );
      create table dispatch_commitment (
        id text primary key, delivery_id text not null references delivery_operation(id), driver_profile_id text not null references driver_profile(id),
        generation integer not null check(generation>0), path text not null check(path in ('MERCHANT','PLATFORM')),
        status text not null check(status in ('OFFERED','ASSIGNED','DECLINED','EXPIRED','CANCELLED')), revision integer not null default 1 check(revision>0),
        availability_generation text not null, affiliation_id text not null references driver_affiliation(id), profile_revision integer not null, affiliation_revision integer not null,
        expires_at timestamptz not null, assigned_at timestamptz, decided_at timestamptz, reason text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        unique(delivery_id,generation,driver_profile_id),
        check((status='ASSIGNED')=(assigned_at is not null)), check(status='OFFERED' or decided_at is not null)
      );
      create unique index dispatch_one_driver_commitment on dispatch_commitment(driver_profile_id) where status in ('OFFERED','ASSIGNED');
      create unique index dispatch_one_delivery_commitment on dispatch_commitment(delivery_id) where status in ('OFFERED','ASSIGNED');
      create index dispatch_due on delivery_operation(status,deadline,id);
      create index dispatch_candidates on driver_availability(intent,available_since,driver_profile_id);
      create table dispatch_event (
        id text primary key, target_id text not null, target_type text not null check(target_type in ('DELIVERY','AVAILABILITY','CONFIGURATION')),
        revision integer not null check(revision>0), action text not null, actor_type text not null check(actor_type in ('driver','user','system')),
        actor_id text, occurred_at timestamptz not null, evidence jsonb not null check(jsonb_typeof(evidence)='object'),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        unique(target_type,target_id,revision), check(actor_type='system' or actor_id is not null)
      );
      create function gospaza_dispatch_guard() returns trigger language plpgsql as $$
      begin
        if TG_TABLE_NAME='dispatch_event' then raise exception 'Dispatch audit is append only'; end if;
        if TG_OP='UPDATE' and (new.id<>old.id or new.revision<>old.revision+1) then raise exception 'Dispatch identity/revision'; end if;
        if TG_TABLE_NAME='delivery_operation' then
          if not exists(select 1 from order_operation o join pick_session p on p.order_operation_id=o.id
            join delivery_reservation r on r.medusa_order_id=o.medusa_order_id
            where o.id=new.order_operation_id and o.medusa_order_id=new.medusa_order_id and o.merchant_id=new.merchant_id
            and o.merchant_store_id=new.merchant_store_id and p.id=new.pick_session_id and r.id=new.reservation_id)
          then raise exception 'Dispatch order binding'; end if;
          if TG_OP='UPDATE' then
            if (new.order_operation_id,new.medusa_order_id,new.merchant_id,new.merchant_store_id,new.pick_session_id,new.reservation_id,new.service_zone_id)
              is distinct from (old.order_operation_id,old.medusa_order_id,old.merchant_id,old.merchant_store_id,old.pick_session_id,old.reservation_id,old.service_zone_id)
              then raise exception 'Immutable delivery binding'; end if;
            if old.status='ATTENTION_REQUIRED' or (old.status='ASSIGNED' and new.status not in ('ASSIGNED','ATTENTION_REQUIRED'))
              then raise exception 'Terminal delivery'; end if;
            if old.generation=1 and (new.generation<>1 or new.mode<>old.mode or new.started_at<>old.started_at or new.deadline<>old.deadline
              or new.configuration_revision<>old.configuration_revision or new.offer_ms<>old.offer_ms
              or new.merchant_deadline is distinct from old.merchant_deadline or new.dispatch_not_before is distinct from old.dispatch_not_before or (old.path='PLATFORM' and new.path<>'PLATFORM'))
              then raise exception 'Immutable search generation'; end if;
          end if;
        elsif TG_TABLE_NAME='dispatch_commitment' then
          if not exists(select 1 from driver_affiliation a join delivery_operation d on d.id=new.delivery_id
            where a.id=new.affiliation_id and a.driver_profile_id=new.driver_profile_id and a.kind=new.path
              and (a.kind='PLATFORM' or (a.merchant_id=d.merchant_id and a.merchant_store_id=d.merchant_store_id)))
            then raise exception 'Commitment affiliation binding'; end if;
          if TG_OP='INSERT' and new.status<>'OFFERED' then raise exception 'Commitment begins offered'; end if;
          if TG_OP='UPDATE' and (old.status<>'OFFERED' or new.status='OFFERED' or
            (new.delivery_id,new.driver_profile_id,new.generation,new.path,new.availability_generation,new.affiliation_id,new.profile_revision,new.affiliation_revision,new.expires_at)
            is distinct from (old.delivery_id,old.driver_profile_id,old.generation,old.path,old.availability_generation,old.affiliation_id,old.profile_revision,old.affiliation_revision,old.expires_at))
            then raise exception 'Immutable commitment/decision'; end if;
          if not exists(select 1 from delivery_operation d where d.id=new.delivery_id and d.generation=new.generation
            and d.path=new.path and new.expires_at<=d.deadline) then raise exception 'Commitment search binding'; end if;
        elsif TG_TABLE_NAME='driver_availability' then
          if new.affiliation_id is not null and not exists(select 1 from driver_affiliation a where a.id=new.affiliation_id and a.driver_profile_id=new.driver_profile_id) then raise exception 'Availability affiliation owner'; end if;
          if TG_OP='UPDATE' and new.driver_profile_id<>old.driver_profile_id then raise exception 'Immutable availability owner'; end if;
        elsif TG_TABLE_NAME='store_dispatch_configuration' then
          if TG_OP='UPDATE' and new.merchant_store_id<>old.merchant_store_id then raise exception 'Immutable configuration owner'; end if;
        end if;
        return new;
      end; $$;
      create trigger delivery_operation_guard before insert or update on delivery_operation for each row execute function gospaza_dispatch_guard();
      create trigger dispatch_commitment_guard before insert or update on dispatch_commitment for each row execute function gospaza_dispatch_guard();
      create trigger driver_availability_guard before insert or update on driver_availability for each row execute function gospaza_dispatch_guard();
      create trigger store_dispatch_configuration_guard before insert or update on store_dispatch_configuration for each row execute function gospaza_dispatch_guard();
      create trigger dispatch_event_guard before update on dispatch_event for each row execute function gospaza_dispatch_guard();
      create function gospaza_dispatch_consistency() returns trigger language plpgsql as $$
      declare d delivery_operation; n integer; a integer; target text; kind text;
      begin
        if TG_TABLE_NAME='dispatch_commitment' then target:=new.delivery_id;
        elsif TG_TABLE_NAME='delivery_operation' then target:=new.id;
        else target:=null; end if;
        if target is not null then
          select * into d from delivery_operation where id=target;
          if not found then return null; end if;
          select count(*),count(*) filter(where status='ASSIGNED') into n,a from dispatch_commitment where delivery_id=target and status in ('OFFERED','ASSIGNED');
          if (d.status='OFFERED' and (n<>1 or a<>0)) or (d.status='ASSIGNED' and a<>1)
            or (d.status in ('SEARCHING','PENDING_DISPATCH') and n<>0)
            or (d.status='ATTENTION_REQUIRED' and n<>a) then raise exception 'Dispatch commitment state mismatch'; end if;
        end if;
        if TG_TABLE_NAME='dispatch_commitment' then return null; end if;
        kind:=case TG_TABLE_NAME when 'delivery_operation' then 'DELIVERY' when 'driver_availability' then 'AVAILABILITY' else 'CONFIGURATION' end;
        if not exists(select 1 from dispatch_event where target_id=new.id and target_type=kind and revision=new.revision)
          then raise exception 'Dispatch audit required'; end if;
        return null;
      end; $$;
      create constraint trigger delivery_consistency after insert or update on delivery_operation deferrable initially deferred for each row execute function gospaza_dispatch_consistency();
      create constraint trigger commitment_consistency after insert or update on dispatch_commitment deferrable initially deferred for each row execute function gospaza_dispatch_consistency();
      create constraint trigger availability_audit after insert or update on driver_availability deferrable initially deferred for each row execute function gospaza_dispatch_consistency();
      create constraint trigger dispatch_config_audit after insert or update on store_dispatch_configuration deferrable initially deferred for each row execute function gospaza_dispatch_consistency();
    `);
  }
  async down(): Promise<void> {
    this.addSql(`drop table dispatch_event, dispatch_commitment, delivery_operation, driver_availability, store_dispatch_configuration;
      drop function gospaza_dispatch_consistency(); drop function gospaza_dispatch_guard();`);
  }
}
