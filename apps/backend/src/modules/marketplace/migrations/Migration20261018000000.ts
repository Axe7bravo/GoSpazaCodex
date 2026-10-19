import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261018000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table driver_profile (
        id text primary key, auth_identity_id text not null unique,
        display_name text not null default '' check(length(display_name)<=120),
        contact_phone text not null default '' check(length(contact_phone)<=30),
        status text not null default 'INCOMPLETE' check(status in ('INCOMPLETE','PENDING_REVIEW','CHANGES_REQUIRED','ACTIVE','SUSPENDED','DEACTIVATED')),
        revision integer not null default 1 check(revision>0), submitted_at timestamptz, reviewed_at timestamptz, reviewed_by text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null)
      );
      create table driver_affiliation (
        id text primary key, driver_profile_id text not null references driver_profile(id) on delete restrict,
        kind text not null check(kind in ('PLATFORM','MERCHANT')),
        status text not null check(status in ('REQUESTED','ENDORSED','ACTIVE','REJECTED','REVOKED')),
        revision integer not null default 1 check(revision>0), merchant_id text references merchant(id) on delete restrict,
        merchant_store_id text, endorsed_by text, activated_by text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        foreign key(merchant_store_id,merchant_id) references merchant_store(id,merchant_id) on delete restrict,
        check((kind='PLATFORM' and merchant_id is null and merchant_store_id is null and status<>'ENDORSED')
          or (kind='MERCHANT' and merchant_id is not null and merchant_store_id is not null)),
        check(status<>'ACTIVE' or activated_by is not null),
        check(kind<>'MERCHANT' or status not in ('ENDORSED','ACTIVE') or endorsed_by is not null)
      );
      create unique index driver_affiliation_one_open on driver_affiliation(driver_profile_id) where status in ('REQUESTED','ENDORSED','ACTIVE');
      create index driver_affiliation_tenant on driver_affiliation(merchant_id,merchant_store_id,created_at,id);
      create table driver_event (
        id text primary key, driver_profile_id text not null references driver_profile(id) on delete restrict,
        affiliation_id text references driver_affiliation(id) on delete restrict,
        action text not null, actor_type text not null check(actor_type in ('driver','merchant','user')), actor_id text not null,
        merchant_id text, merchant_store_id text, from_status text, to_status text not null,
        previous_revision integer not null, revision integer not null, evidence jsonb not null check(jsonb_typeof(evidence)='object'), request_fingerprint text not null,
        reason text not null check(length(reason)<=500), occurred_at timestamptz not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        constraint driver_event_profile_revision unique(driver_profile_id,revision), check(revision=previous_revision+1)
      );
      create function gospaza_driver_profile_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP='INSERT' then
          if new.status<>'INCOMPLETE' or new.revision<>1 then raise exception 'Driver begins incomplete'; end if;
        else
          if new.id<>old.id or new.auth_identity_id<>old.auth_identity_id or new.revision<>old.revision+1 then raise exception 'Immutable driver identity/revision'; end if;
          if old.status='DEACTIVATED' then raise exception 'Deactivated driver is terminal'; end if;
          if (new.display_name<>old.display_name or new.contact_phone<>old.contact_phone) and old.status not in ('INCOMPLETE','CHANGES_REQUIRED') then raise exception 'Reviewed fields are immutable'; end if;
          if new.status<>old.status and not (
            (old.status in ('INCOMPLETE','CHANGES_REQUIRED') and new.status='PENDING_REVIEW') or
            (old.status='PENDING_REVIEW' and new.status in ('ACTIVE','CHANGES_REQUIRED')) or
            (old.status='ACTIVE' and new.status in ('SUSPENDED','DEACTIVATED')) or
            (old.status='SUSPENDED' and new.status in ('ACTIVE','DEACTIVATED')) or
            (old.status='CHANGES_REQUIRED' and new.status='DEACTIVATED')
          ) then raise exception 'Invalid driver transition'; end if;
        end if;
        if new.status in ('PENDING_REVIEW','ACTIVE') and (length(trim(new.display_name))=0 or length(trim(new.contact_phone))<7 or new.submitted_at is null) then raise exception 'Complete submission required'; end if;
        return new;
      end; $$;
      create trigger driver_profile_guard before insert or update on driver_profile for each row execute function gospaza_driver_profile_guard();
      create function gospaza_driver_affiliation_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP='INSERT' then
          if new.status<>'REQUESTED' or new.revision<>1 then raise exception 'Affiliation starts requested'; end if;
        else
          if new.id<>old.id or new.driver_profile_id<>old.driver_profile_id or new.kind<>old.kind
            or new.merchant_id is distinct from old.merchant_id or new.merchant_store_id is distinct from old.merchant_store_id
            or new.revision<>old.revision+1 then raise exception 'Immutable affiliation binding'; end if;
          if not ((old.status='REQUESTED' and new.status in ('ENDORSED','REJECTED','REVOKED'))
            or (old.status='REQUESTED' and old.kind='PLATFORM' and new.status='ACTIVE')
            or (old.status='ENDORSED' and new.status in ('ACTIVE','REVOKED'))
            or (old.status='ACTIVE' and new.status='REVOKED')) then raise exception 'Invalid affiliation transition'; end if;
        end if;
        return new;
      end; $$;
      create trigger driver_affiliation_guard before insert or update on driver_affiliation for each row execute function gospaza_driver_affiliation_guard();
      create function gospaza_driver_audit_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP='UPDATE' then raise exception 'Driver audit is append-only'; end if;
        if new.affiliation_id is not null and not exists(select 1 from driver_affiliation where id=new.affiliation_id and driver_profile_id=new.driver_profile_id
          and merchant_id is not distinct from new.merchant_id and merchant_store_id is not distinct from new.merchant_store_id) then raise exception 'Driver audit scope mismatch'; end if;
        return new;
      end; $$;
      create trigger driver_audit_guard before insert or update on driver_event for each row execute function gospaza_driver_audit_guard();
      create function gospaza_driver_commit_guard() returns trigger language plpgsql as $$
      begin
        if not exists(select 1 from driver_profile where id=new.id) then return null; end if;
        if not exists(select 1 from driver_event where driver_profile_id=new.id and revision=new.revision) then raise exception 'Driver transition requires audit'; end if;
        if (TG_OP='INSERT' or old.status<>new.status) and new.status='ACTIVE'
          and not exists(select 1 from driver_affiliation where driver_profile_id=new.id and status='ACTIVE') then raise exception 'Activation requires active affiliation'; end if;
        return null;
      end; $$;
      create constraint trigger driver_commit_guard after insert or update on driver_profile deferrable initially deferred for each row execute function gospaza_driver_commit_guard();
    `);
  }
}
