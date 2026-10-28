import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261025120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table merchant_store add constraint restricted_store_tenant unique(id,merchant_id);
      create table restricted_registration (
        id text primary key, merchant_id text not null, merchant_store_id text not null unique,
        status text not null check(status in ('PENDING_REVIEW','CHANGES_REQUIRED','ACTIVE','SUSPENDED','REVOKED')),
        revision integer not null default 1 check(revision>0), submission jsonb not null, pending_submission jsonb,
        trading_policy jsonb, premises_fingerprint text, reviewed_by text,
        submitted_at timestamptz not null, reviewed_at timestamptz, approved_at timestamptz,
        suspended_at timestamptz, revoked_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        foreign key(merchant_store_id,merchant_id) references merchant_store(id,merchant_id) on delete cascade,
        check(status<>'ACTIVE' or (trading_policy is not null and premises_fingerprint is not null and reviewed_by is not null and approved_at is not null))
      );
      create table restricted_evidence (
        id text primary key, merchant_id text not null, merchant_store_id text not null,
        storage_key text not null unique, display_name text not null, mime_type text not null,
        size_bytes integer not null check(size_bytes>0 and size_bytes<=10485760),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        foreign key(merchant_store_id,merchant_id) references merchant_store(id,merchant_id) on delete cascade
      );
      create table restriction_review (
        id text primary key, product_profile_id text not null references product_marketplace_profile(id) on delete cascade,
        identity_fingerprint text not null, revision integer not null check(revision>0), restriction text not null check(restriction in ('NONE','ALCOHOL')),
        alcohol_class text check(alcohol_class in ('WINE','BEER','SPIRITS','OTHER')),
        reviewer_id text not null, reason text not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        check((restriction='NONE')=(alcohol_class is null)), unique(product_profile_id,revision)
      );
      create index restriction_review_profile on restriction_review(product_profile_id,revision);
      create table purchaser_eligibility (
        id text primary key, customer_id text not null, method text not null, method_version text not null,
        policy_version text not null, minimum_age integer not null check(minimum_age=18),
        provincial_requirements_satisfied boolean not null,
        state text not null check(state in ('UNVERIFIED','PENDING','VERIFIED','EXPIRED','REVOKED')),
        verified_at timestamptz, expires_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        check(state<>'VERIFIED' or (verified_at is not null and provincial_requirements_satisfied))
      );
      create index purchaser_eligibility_customer on purchaser_eligibility(customer_id);
      create table restricted_event (
        id text primary key, merchant_id text, merchant_store_id text, target_id text not null,
        actor_id text not null, action text not null, evidence jsonb not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        foreign key(merchant_store_id,merchant_id) references merchant_store(id,merchant_id) on delete cascade
      );
      create index restricted_event_target on restricted_event(target_id,created_at);
      create function gospaza_restricted_immutable() returns trigger language plpgsql as $$ begin
        -- Only destruction of the owning aggregate may cascade. No API exposes
        -- that operation; existing isolated fixture cleanup owns its exact rows.
        if TG_OP='DELETE' and pg_trigger_depth()>1 then return old; end if;
        raise exception using errcode='23514', message='Restricted evidence is append-only';
      end $$;
      create trigger restriction_review_immutable before update or delete on restriction_review for each row execute function gospaza_restricted_immutable();
      create trigger restricted_event_immutable before update or delete on restricted_event for each row execute function gospaza_restricted_immutable();
      create trigger restricted_evidence_immutable before update or delete on restricted_evidence for each row execute function gospaza_restricted_immutable();
      create function gospaza_registration_identity() returns trigger language plpgsql as $$ begin
        if new.id<>old.id or new.merchant_id<>old.merchant_id or new.merchant_store_id<>old.merchant_store_id
          or new.revision<>old.revision+1 or new.deleted_at is distinct from old.deleted_at
          or old.status='REVOKED' then
          raise exception using errcode='23514', message='Restricted registration identity/revision';
        end if;
        return new;
      end $$;
      create trigger restricted_registration_identity before update on restricted_registration for each row execute function gospaza_registration_identity();
      create function gospaza_purchaser_identity() returns trigger language plpgsql as $$ begin
        if new.id<>old.id or new.customer_id<>old.customer_id or new.method<>old.method
          or new.method_version<>old.method_version or new.policy_version<>old.policy_version
          or old.state in ('REVOKED','EXPIRED') then
          raise exception using errcode='23514', message='Purchaser evidence identity';
        end if;
        return new;
      end $$;
      create trigger purchaser_eligibility_identity before update on purchaser_eligibility for each row execute function gospaza_purchaser_identity();
      create function gospaza_restricted_delivery_monotonic() returns trigger language plpgsql as $$ begin
        if old.restricted_content_present and not new.restricted_content_present then
          raise exception using errcode='23514', message='Restricted delivery cannot be downgraded';
        end if;
        return new;
      end $$;
      create trigger restricted_delivery_monotonic before update on delivery_operation for each row execute function gospaza_restricted_delivery_monotonic();
    `);
  }
  async down(): Promise<void> {
    throw new Error("Restricted compliance history cannot be destructively rolled back.");
  }
}
