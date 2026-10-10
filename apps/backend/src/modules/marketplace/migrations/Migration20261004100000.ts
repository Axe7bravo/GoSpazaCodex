import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261004100000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table checkout_attempt drop constraint checkout_attempt_state_check;
      -- PostgreSQL names the unnamed cross-column check separately.
      do $$ declare r record; begin
        for r in select conname from pg_constraint where conrelid = 'checkout_attempt'::regclass
          and contype = 'c' and pg_get_constraintdef(oid) like '%closed_at%'
        loop execute format('alter table checkout_attempt drop constraint %I', r.conname); end loop;
      end $$;
      alter table checkout_attempt add column payment_deadline timestamptz;
      alter table checkout_attempt add constraint checkout_state check(state in ('CONFIRMED','PAYMENT_PENDING','ABANDONED','EXPIRED'));
      alter table checkout_attempt add constraint checkout_open_state check(
        (state in ('CONFIRMED','PAYMENT_PENDING')) = (closed_at is null));
      alter table checkout_attempt add constraint checkout_payment_deadline check(
        state <> 'PAYMENT_PENDING' or payment_deadline is not null);
      create or replace function gospaza_checkout_snapshot_immutable() returns trigger language plpgsql as $$ begin
        if old.id is distinct from new.id or old.created_at is distinct from new.created_at
          or old.snapshot is distinct from new.snapshot or old.checkout_revision is distinct from new.checkout_revision
          or old.cart_context_id is distinct from new.cart_context_id or old.medusa_cart_id is distinct from new.medusa_cart_id
          or old.reservation_id is distinct from new.reservation_id or old.expires_at is distinct from new.expires_at
          or old.closed_at is not null
          or (old.payment_deadline is not null and old.payment_deadline is distinct from new.payment_deadline)
          or (old.state = 'PAYMENT_PENDING' and new.state not in ('PAYMENT_PENDING','EXPIRED')) then
          raise exception 'Checkout snapshot is immutable';
        end if;
        return new;
      end; $$;

      alter table delivery_reservation drop constraint delivery_reservation_status_check;
      alter table delivery_reservation add column payment_deadline timestamptz;
      alter table delivery_reservation add constraint delivery_payment_status check(status in ('HELD','PAYMENT_PENDING','RELEASED','EXPIRED'));
      alter table delivery_reservation add constraint delivery_payment_deadline check(
        status <> 'PAYMENT_PENDING' or (payment_deadline is not null and released_at is null));
      drop index delivery_one_held_per_cart;
      create unique index delivery_one_held_per_cart on delivery_reservation(cart_context_id)
        where status in ('HELD','PAYMENT_PENDING');
      create index delivery_pending_deadline on delivery_reservation(payment_deadline) where status = 'PAYMENT_PENDING';
      create function gospaza_reservation_payment_deadline() returns trigger language plpgsql as $$ begin
        if old.payment_deadline is not null and
          (old.payment_deadline is distinct from new.payment_deadline or new.status = 'HELD') then
          raise exception 'Payment capacity deadline is immutable';
        end if;
        return new;
      end; $$;
      create trigger reservation_payment_deadline before update on delivery_reservation
        for each row execute function gospaza_reservation_payment_deadline();


      create table provider_operation (
        id text primary key, checkout_attempt_id text not null unique references checkout_attempt(id),
        payment_collection_id text, amount_minor bigint not null check(amount_minor >= 200 and amount_minor <= 9007199254740991),
        currency_code text not null default 'zar' check(currency_code = 'zar'), mode text not null check(mode in ('test','live')),
        account_fingerprint text not null, idempotency_key text not null unique,
        request_json text not null, request_fingerprint text not null,
        state text not null default 'prepared' check(state in ('prepared','sending','uncertain','created','mismatch')),
        checkout_id text, checkout_receipt jsonb, verified_payment jsonb, terminal_refunded boolean not null default false,
        session_token text, replay_allowed boolean not null default false,
        canonical_session_id text, financial_session_id text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        unique(id, payment_collection_id)
      );
      create unique index provider_checkout_unique on provider_operation(checkout_id) where checkout_id is not null;
      create unique index provider_collection_unique on provider_operation(payment_collection_id) where payment_collection_id is not null;
      create table provider_session (
        id text primary key, operation_id text not null references provider_operation(id),
        native_session_id text not null unique, payment_collection_id text not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        unique(operation_id, native_session_id),
        foreign key(operation_id, payment_collection_id) references provider_operation(id, payment_collection_id)
      );
      alter table provider_operation add constraint canonical_session_owned
        foreign key(id, canonical_session_id) references provider_session(operation_id, native_session_id) deferrable initially deferred;
      alter table provider_operation add constraint financial_session_owned
        foreign key(id, financial_session_id) references provider_session(operation_id, native_session_id) deferrable initially deferred;
      create function gospaza_provider_operation_immutable() returns trigger language plpgsql as $$ begin
        if old.id is distinct from new.id or old.checkout_attempt_id is distinct from new.checkout_attempt_id
          or old.amount_minor is distinct from new.amount_minor or old.currency_code is distinct from new.currency_code
          or old.mode is distinct from new.mode or old.account_fingerprint is distinct from new.account_fingerprint
          or old.idempotency_key is distinct from new.idempotency_key or old.request_json is distinct from new.request_json
          or old.request_fingerprint is distinct from new.request_fingerprint or old.created_at is distinct from new.created_at
          or (old.payment_collection_id is not null and old.payment_collection_id is distinct from new.payment_collection_id)
          or (old.checkout_id is not null and old.checkout_id is distinct from new.checkout_id)
          or (old.financial_session_id is not null and old.financial_session_id is distinct from new.financial_session_id)
          or (old.terminal_refunded and not new.terminal_refunded)
          or (old.financial_session_id is not null and new.canonical_session_id is distinct from old.financial_session_id)
          or old.deleted_at is distinct from new.deleted_at then
          raise exception 'Provider operation identity is immutable';
        end if;
        return new;
      end; $$;
      create trigger provider_operation_immutable before update on provider_operation
        for each row execute function gospaza_provider_operation_immutable();
      create trigger provider_session_immutable before update on provider_session
        for each row execute function gospaza_immutable_review();
    `);
  }

  async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists(select 1 from provider_operation) or exists(select 1 from checkout_attempt where payment_deadline is not null) then
        raise exception 'Payment history exists; explicit data migration required';
      end if;
    end $$;
    alter table provider_operation drop constraint canonical_session_owned, drop constraint financial_session_owned;
    drop table provider_session, provider_operation;
    drop function gospaza_provider_operation_immutable();
    drop trigger reservation_payment_deadline on delivery_reservation;
    drop function gospaza_reservation_payment_deadline();
    alter table delivery_reservation drop constraint delivery_payment_status, drop constraint delivery_payment_deadline;
    drop index delivery_pending_deadline;
    alter table delivery_reservation drop column payment_deadline;
    alter table delivery_reservation add constraint delivery_reservation_status_check check(status in ('HELD','RELEASED','EXPIRED'));
    drop index delivery_one_held_per_cart;
    create unique index delivery_one_held_per_cart on delivery_reservation(cart_context_id) where status = 'HELD';
    alter table checkout_attempt drop constraint checkout_state, drop constraint checkout_open_state, drop constraint checkout_payment_deadline;
    alter table checkout_attempt add constraint checkout_attempt_state_check check(state in ('CONFIRMED','ABANDONED','EXPIRED'));
    alter table checkout_attempt add constraint checkout_open_state check((state = 'CONFIRMED') = (closed_at is null));
    alter table checkout_attempt drop column payment_deadline;
      create or replace function gospaza_checkout_snapshot_immutable() returns trigger language plpgsql as $$ begin
        if old.id is distinct from new.id or old.created_at is distinct from new.created_at
          or old.snapshot is distinct from new.snapshot or old.checkout_revision is distinct from new.checkout_revision
          or old.cart_context_id is distinct from new.cart_context_id or old.medusa_cart_id is distinct from new.medusa_cart_id
          or old.reservation_id is distinct from new.reservation_id or old.expires_at is distinct from new.expires_at
          or old.closed_at is not null then
          raise exception 'Checkout snapshot is immutable';
        end if;
        return new;
      end; $$;
    `);
  }
}
