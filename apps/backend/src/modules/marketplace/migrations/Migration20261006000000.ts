import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261006000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table provider_operation add column reconciliation_pending boolean not null default false;
      alter table checkout_attempt add column payment_accepted_at timestamptz;
      alter table checkout_attempt drop constraint checkout_state, drop constraint checkout_open_state;
      alter table checkout_attempt add constraint checkout_state check(state in
        ('CONFIRMED','PAYMENT_PENDING','RECOVERY_REQUIRED','COMPLETED','FAILED','ABANDONED','EXPIRED'));
      alter table checkout_attempt add constraint checkout_open_state check(
        (state in ('CONFIRMED','PAYMENT_PENDING','RECOVERY_REQUIRED')) = (closed_at is null));
      create or replace function gospaza_checkout_snapshot_immutable() returns trigger language plpgsql as $$ begin
        if old.id is distinct from new.id or old.created_at is distinct from new.created_at
          or old.snapshot is distinct from new.snapshot or old.checkout_revision is distinct from new.checkout_revision
          or old.cart_context_id is distinct from new.cart_context_id or old.medusa_cart_id is distinct from new.medusa_cart_id
          or old.reservation_id is distinct from new.reservation_id or old.expires_at is distinct from new.expires_at
          or old.closed_at is not null
          or (old.payment_deadline is not null and old.payment_deadline is distinct from new.payment_deadline)
          or (old.payment_accepted_at is not null and (old.payment_accepted_at is distinct from new.payment_accepted_at
            or new.state not in ('PAYMENT_PENDING','RECOVERY_REQUIRED','COMPLETED')))
          or (old.state = 'PAYMENT_PENDING' and new.state not in ('PAYMENT_PENDING','EXPIRED','FAILED','RECOVERY_REQUIRED','COMPLETED'))
          or (old.state = 'RECOVERY_REQUIRED' and new.state not in ('RECOVERY_REQUIRED','COMPLETED')) then
          raise exception 'Checkout snapshot is immutable';
        end if;
        return new;
      end; $$;
      alter table delivery_reservation add column payment_accepted_at timestamptz, add column medusa_order_id text;
      alter table delivery_reservation drop constraint delivery_payment_status;
      alter table delivery_reservation add constraint delivery_payment_status check(status in
        ('HELD','PAYMENT_PENDING','COMMITTED','RELEASED','EXPIRED'));
      alter table delivery_reservation add constraint delivery_committed_order check(
        (status = 'COMMITTED') = (medusa_order_id is not null));
      create unique index delivery_committed_order_unique on delivery_reservation(medusa_order_id) where medusa_order_id is not null;
      drop index delivery_one_held_per_cart;
      create unique index delivery_one_held_per_cart on delivery_reservation(cart_context_id)
        where status in ('HELD','PAYMENT_PENDING','COMMITTED');
      create or replace function gospaza_reservation_payment_deadline() returns trigger language plpgsql as $$ begin
        if (old.payment_deadline is not null and
          (old.payment_deadline is distinct from new.payment_deadline or new.status = 'HELD'))
          or (old.payment_accepted_at is not null and (old.payment_accepted_at is distinct from new.payment_accepted_at
            or new.status not in ('PAYMENT_PENDING','COMMITTED')))
          or (old.status = 'COMMITTED' and (new.status <> 'COMMITTED' or old.medusa_order_id is distinct from new.medusa_order_id)) then
          raise exception 'Payment capacity commitment is immutable';
        end if;
        return new;
      end; $$;
      create table checkout_completion (
        id text primary key, checkout_attempt_id text not null unique references checkout_attempt(id),
        operation_id text not null unique references provider_operation(id),
        workflow_id text not null check(workflow_id = 'complete-cart'), transaction_id text not null unique,
        input_fingerprint text not null, state text not null default 'READY'
          check(state in ('READY','DISPATCHED','SUCCEEDED','RECOVERY_REQUIRED')),
        dispatched_at timestamptz, execution_id text, run_id text, native_state text, unresolved jsonb,
        order_id text, terminal_receipt jsonb, recovery_reason text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        check((state = 'READY') = (dispatched_at is null)),
        check(state <> 'SUCCEEDED' or (order_id is not null and terminal_receipt is not null))
      );
      create function gospaza_completion_immutable() returns trigger language plpgsql as $$ begin
        if old.id is distinct from new.id or old.checkout_attempt_id is distinct from new.checkout_attempt_id
          or old.operation_id is distinct from new.operation_id or old.workflow_id is distinct from new.workflow_id
          or old.transaction_id is distinct from new.transaction_id or old.input_fingerprint is distinct from new.input_fingerprint
          or (old.dispatched_at is not null and old.dispatched_at is distinct from new.dispatched_at)
          or (old.execution_id is not null and old.execution_id is distinct from new.execution_id)
          or (old.run_id is not null and old.run_id is distinct from new.run_id)
          or old.state = 'SUCCEEDED' or (old.state <> 'READY' and new.state = 'READY') then
          raise exception 'Completion identity/receipt is immutable';
        end if;
        return new;
      end; $$;
      create trigger completion_immutable before update on checkout_completion for each row execute function gospaza_completion_immutable();
      create table yoco_inbox (
        id text primary key, event_id text not null unique, body_fingerprint text not null, event jsonb not null,
        state text not null default 'RECEIVED' check(state in ('RECEIVED','APPLIED','REJECTED')), rejection_code text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
      );
      create function gospaza_inbox_immutable() returns trigger language plpgsql as $$ begin
        if old.id is distinct from new.id or old.event_id is distinct from new.event_id
          or old.body_fingerprint is distinct from new.body_fingerprint or old.event is distinct from new.event
          or old.created_at is distinct from new.created_at or old.deleted_at is distinct from new.deleted_at
          or (old.state <> 'RECEIVED' and old.state is distinct from new.state) then
          raise exception 'Verified inbox evidence is immutable';
        end if;
        return new;
      end; $$;
      create trigger inbox_immutable before update on yoco_inbox for each row execute function gospaza_inbox_immutable();
      create table technical_compensation (
        id text primary key, operation_id text not null unique references provider_operation(id),
        native_payment_id text not null unique, provider_payment_id text not null unique,
        amount_minor bigint not null check(amount_minor >= 200 and amount_minor <= 9007199254740991),
        idempotency_key text not null unique, request_json text not null, reason text not null,
        state text not null default 'prepared' check(state in ('prepared','sending','uncertain','pending','succeeded')),
        receipt jsonb, verified_event jsonb, native_refund_id text, native_dispatch_at timestamptz,
        replay_allowed boolean not null default false, recovery_required boolean not null default false,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
      );
      create function gospaza_compensation_approval() returns trigger language plpgsql as $$ begin
        if not exists(select 1 from provider_operation o join checkout_attempt a on a.id = o.checkout_attempt_id
          where o.id = new.operation_id and a.closed_at is not null and a.payment_accepted_at is null
            and a.state in ('EXPIRED','FAILED','ABANDONED') and o.verified_payment->>'type' = 'payment.succeeded'
            and o.verified_payment->>'paymentId' = new.provider_payment_id and o.amount_minor = new.amount_minor)
          or exists(select 1 from checkout_completion where operation_id = new.operation_id) then
          raise exception 'Technical refund has no safe closed-attempt approval';
        end if;
        return new;
      end; $$;
      create trigger compensation_approval before insert on technical_compensation for each row execute function gospaza_compensation_approval();
      create function gospaza_compensation_immutable() returns trigger language plpgsql as $$ begin
        if old.id is distinct from new.id or old.operation_id is distinct from new.operation_id
          or old.native_payment_id is distinct from new.native_payment_id or old.provider_payment_id is distinct from new.provider_payment_id
          or old.amount_minor is distinct from new.amount_minor or old.idempotency_key is distinct from new.idempotency_key
          or old.request_json is distinct from new.request_json or old.reason is distinct from new.reason
          or (old.state = 'succeeded' and new.state <> 'succeeded') then
          raise exception 'Technical compensation identity is immutable';
        end if;
        return new;
      end; $$;
      create trigger compensation_immutable before update on technical_compensation for each row execute function gospaza_compensation_immutable();
      create unique index provider_payment_identity on provider_operation ((verified_payment->>'paymentId'))
        where verified_payment->>'type' = 'payment.succeeded';
    `);
  }
  async down(): Promise<void> {
    // Financial recovery history must never be silently discarded by rollback.
    throw new Error("M10-E reconciliation requires an explicit forward data migration.");
  }
}
