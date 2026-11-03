import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261030120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table financial_settlement (
        id text primary key, adjustment_id text not null references financial_adjustment(id),
        method text not null check (method in ('ORIGINAL_PAYMENT','STORE_CREDIT')),
        amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 9007199254740991),
        currency text not null check (currency = 'zar'),
        state text not null check (state in ('RESERVED','SETTLED','RELEASED')),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check (deleted_at is null)
      );
    `);
    this.addSql(`
      create index financial_settlement_adjustment on financial_settlement(adjustment_id);
    `);
    this.addSql(`
      create function gospaza_settlement_guard() returns trigger as $gospaza$
      declare adjustment_row financial_adjustment; allocated bigint;
      begin
        if TG_OP = 'DELETE' then raise exception 'Settlement history immutable'; end if;
        select * into strict adjustment_row from financial_adjustment where id=NEW.adjustment_id for update;
        if TG_OP = 'UPDATE' and ((to_jsonb(NEW)-array['state','updated_at']) is distinct from (to_jsonb(OLD)-array['state','updated_at'])
          or OLD.state <> 'RESERVED' or NEW.state not in ('SETTLED','RELEASED')) then raise exception 'Settlement transition'; end if;
        if adjustment_row.status <> 'APPROVED' or not (adjustment_row.eligible_methods @> jsonb_build_array(NEW.method))
          or NEW.currency <> adjustment_row.currency then raise exception 'Settlement eligibility'; end if;
        select coalesce(sum(amount_minor),0) into allocated from financial_settlement
          where adjustment_id=NEW.adjustment_id and id<>NEW.id and state in ('RESERVED','SETTLED');
        if allocated + (case when NEW.state='RELEASED' then 0 else NEW.amount_minor end) > adjustment_row.amount_minor
          then raise exception 'Settlement entitlement exceeded'; end if;
        return NEW;
      END;
      $gospaza$
      language plpgsql;
    `);
    this.addSql(`
      create trigger financial_settlement_guard before insert or update or delete on financial_settlement for each row execute function gospaza_settlement_guard();

    `);
    this.addSql(`
      create table refund_operation (
        id text primary key, settlement_id text not null unique references financial_settlement(id),
        adjustment_id text not null unique references financial_adjustment(id), order_id text not null,
        merchant_id text not null, store_id text not null, customer_id text,
        provider_operation_id text not null references provider_operation(id), checkout_id text not null,
        provider_payment_id text not null, payment_id text not null, capture_id text not null,
        account_fingerprint text not null, mode text not null check (mode in ('test','live')),
        amount_minor bigint not null check (amount_minor>0 and amount_minor<=9007199254740991), currency text not null check (currency='zar'),
        status text not null check (status in ('CREATED','REQUESTED','UNKNOWN','FAILED_NOT_CREATED','FAILED','PROVIDER_SUCCEEDED','ATTENTION_REQUIRED','SETTLED')),
        revision integer not null default 1, current_attempt_id text,
        native_dispatched_at timestamptz, native_refund_id text unique,
        order_dispatched_at timestamptz, order_transaction_id text unique,
        attention_reason text, settled_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check (deleted_at is null),
        check ((status='SETTLED') = (settled_at is not null)),
        check (status<>'SETTLED' or (native_refund_id is not null and order_transaction_id is not null))
      );
    `);
    this.addSql(`
      create unique index refund_checkout_busy on refund_operation(account_fingerprint,checkout_id)
        where status not in ('SETTLED','FAILED_NOT_CREATED','FAILED');
    `);
    this.addSql(`
      create table provider_refund_attempt (
        id text primary key, refund_operation_id text not null references refund_operation(id),
        attempt_number integer not null check (attempt_number>0), idempotency_key text not null unique,
        request_json text not null, request_fingerprint text not null, request_version text not null,
        status text not null check (status in ('CREATED','SENDING','UNKNOWN','PENDING','FAILED_NOT_CREATED','FAILED','SUCCEEDED')),
        provider_refund_id text unique, first_sent_at timestamptz, lease_until timestamptz,
        verified_event_id text references yoco_inbox(event_id), response_status integer,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check (deleted_at is null),
        unique(refund_operation_id,attempt_number), unique(id,refund_operation_id)
      );
    `);
    this.addSql(`
      alter table refund_operation add constraint refund_current_attempt foreign key(current_attempt_id,id)
        references provider_refund_attempt(id,refund_operation_id) deferrable initially deferred;
    `);
    this.addSql(`
      create table refund_event (
        id text primary key, refund_operation_id text not null references refund_operation(id), revision integer not null,
        action text not null, actor_id text, status text not null, evidence jsonb not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        unique(refund_operation_id,revision)
      );
    `);
    this.addSql(`
      create function gospaza_refund_guard() returns trigger as $gospaza$
      declare adjustment_row financial_adjustment; settlement_row financial_settlement; provider_row provider_operation;
      begin
        if TG_OP='DELETE' then raise exception 'Refund history immutable'; end if;
        select * into strict adjustment_row from financial_adjustment where id=NEW.adjustment_id;
        select * into strict settlement_row from financial_settlement where id=NEW.settlement_id;
        select * into strict provider_row from provider_operation where id=NEW.provider_operation_id;
        if settlement_row.adjustment_id<>NEW.adjustment_id or settlement_row.method<>'ORIGINAL_PAYMENT'
          or settlement_row.amount_minor<>NEW.amount_minor or NEW.amount_minor<>adjustment_row.amount_minor
          or NEW.order_id<>adjustment_row.medusa_order_id or NEW.merchant_id<>adjustment_row.merchant_id
          or NEW.store_id<>adjustment_row.merchant_store_id or NEW.customer_id is distinct from adjustment_row.customer_id
          or provider_row.checkout_id<>NEW.checkout_id or provider_row.account_fingerprint<>NEW.account_fingerprint
          or provider_row.mode<>NEW.mode or provider_row.verified_payment->>'paymentId' is distinct from NEW.provider_payment_id
          or provider_row.verified_payment->>'type' is distinct from 'payment.succeeded'
          or not exists (select 1 from checkout_completion cc join order_operation oo on oo.checkout_completion_id=cc.id
            where oo.id=adjustment_row.order_operation_id and cc.operation_id=provider_row.id and cc.state='SUCCEEDED'
              and cc.terminal_receipt->>'payment_id'=NEW.payment_id and cc.terminal_receipt->>'capture_id'=NEW.capture_id)
          then raise exception 'Refund source mismatch'; end if;
        if TG_OP='UPDATE' then
          if (to_jsonb(NEW)-array['status','revision','current_attempt_id','native_dispatched_at','native_refund_id','order_dispatched_at','order_transaction_id','attention_reason','settled_at','updated_at'])
            is distinct from (to_jsonb(OLD)-array['status','revision','current_attempt_id','native_dispatched_at','native_refund_id','order_dispatched_at','order_transaction_id','attention_reason','settled_at','updated_at'])
            or NEW.revision<>OLD.revision+1 or OLD.status='SETTLED'
            or (OLD.native_refund_id is not null and NEW.native_refund_id is distinct from OLD.native_refund_id)
            or (OLD.order_transaction_id is not null and NEW.order_transaction_id is distinct from OLD.order_transaction_id)
            or (OLD.native_dispatched_at is not null and NEW.native_dispatched_at is distinct from OLD.native_dispatched_at)
            or (OLD.order_dispatched_at is not null and NEW.order_dispatched_at is distinct from OLD.order_dispatched_at)
            then raise exception 'Immutable refund identity or progress'; end if;
        end if;
        return NEW;
      END;
      $gospaza$
      language plpgsql;
    `);
    this.addSql(`
      create trigger refund_operation_guard before insert or update or delete on refund_operation for each row execute function gospaza_refund_guard();
    `);
    this.addSql(`
      create function gospaza_refund_attempt_guard() returns trigger as $gospaza$
      declare operation_row refund_operation; previous_attempt provider_refund_attempt;
      begin
        if TG_OP='DELETE' then raise exception 'Refund attempt history immutable'; end if;
        if TG_OP='INSERT' then
          select * into strict operation_row from refund_operation where id=NEW.refund_operation_id for update;
          select * into previous_attempt from provider_refund_attempt where refund_operation_id=NEW.refund_operation_id order by attempt_number desc limit 1;
          if NEW.attempt_number<>coalesce(previous_attempt.attempt_number,0)+1
            or (previous_attempt.id is not null and previous_attempt.status<>'FAILED_NOT_CREATED')
            or NEW.idempotency_key<>'gospaza_'||NEW.id or NEW.request_version<>'M18-C1-1'
            or NEW.request_json::jsonb <> jsonb_build_object('amount',operation_row.amount_minor,'metadata',jsonb_build_object(
              'gospazaRefundOperationId',operation_row.id,'gospazaRefundAttemptId',NEW.id))
            or NEW.status<>'CREATED' or NEW.provider_refund_id is not null or NEW.first_sent_at is not null
            or NEW.verified_event_id is not null then raise exception 'Refund attempt authority'; end if;
          return NEW;
        end if;
        if (to_jsonb(NEW)-array['status','provider_refund_id','first_sent_at','lease_until','verified_event_id','response_status','updated_at'])
          is distinct from (to_jsonb(OLD)-array['status','provider_refund_id','first_sent_at','lease_until','verified_event_id','response_status','updated_at'])
          or (OLD.provider_refund_id is not null and NEW.provider_refund_id is distinct from OLD.provider_refund_id)
          or (OLD.first_sent_at is not null and NEW.first_sent_at is distinct from OLD.first_sent_at)
          or (OLD.verified_event_id is not null and NEW.verified_event_id is distinct from OLD.verified_event_id)
          or (OLD.status='SUCCEEDED' and NEW.status<>'SUCCEEDED') then raise exception 'Immutable provider refund attempt'; end if;
        return NEW;
      END;
      $gospaza$
      language plpgsql;
    `);
    this.addSql(`
      create trigger provider_refund_attempt_guard before insert or update or delete on provider_refund_attempt for each row execute function gospaza_refund_attempt_guard();
    `);
    this.addSql(`
      create function gospaza_refund_audit_guard() returns trigger as $gospaza$
      begin raise exception 'Refund audit append only';
      END;
      $gospaza$
      language plpgsql;
    `);
    this.addSql(`
      create trigger refund_event_guard before update or delete on refund_event for each row execute function gospaza_refund_audit_guard();
    `);
    this.addSql(`
      create function gospaza_refund_consistency() returns trigger as $gospaza$
      declare operation_row refund_operation; reservation_row financial_settlement;
      begin
        select * into strict operation_row from refund_operation where id=NEW.id;
        select * into strict reservation_row from financial_settlement where id=operation_row.settlement_id;
        if not exists(select 1 from refund_event e where e.refund_operation_id=operation_row.id
          and e.revision=operation_row.revision and e.status=operation_row.status)
          then raise exception 'Refund audit required'; end if;
        if reservation_row.state <> (case when operation_row.status='SETTLED' then 'SETTLED' else 'RESERVED' end)
          then raise exception 'Refund reservation consistency'; end if;
        if operation_row.status in ('PROVIDER_SUCCEEDED','SETTLED') and not exists(select 1 from provider_refund_attempt a
          join yoco_inbox yi on yi.event_id=a.verified_event_id
          where a.id=operation_row.current_attempt_id and a.status='SUCCEEDED' and a.provider_refund_id is not null
            and yi.state='APPLIED' and yi.event->>'type'='refund.succeeded'
            and yi.event->>'refundId'=a.provider_refund_id and yi.event->>'checkoutId'=operation_row.checkout_id
            and yi.event->>'paymentId'=operation_row.provider_payment_id
            and (yi.event->>'amount')::bigint=operation_row.amount_minor and yi.event->>'currency'='ZAR' and yi.event->>'mode'=operation_row.mode)
          then raise exception 'Verified refund evidence required'; end if;
        return null;
      END;
      $gospaza$
      language plpgsql;
    `);
    this.addSql(`
      create constraint trigger refund_consistency_check after insert or update on refund_operation
        deferrable initially deferred for each row execute function gospaza_refund_consistency();
    `);
    this.addSql(`
      create function gospaza_refund_reservation_consistency() returns trigger as $gospaza$
      declare operation_row refund_operation; reservation_row financial_settlement;
      begin
        select * into reservation_row from financial_settlement where id=NEW.id;
        select * into operation_row from refund_operation where settlement_id=NEW.id;
        if found and reservation_row.state <> (case when operation_row.status='SETTLED' then 'SETTLED' else 'RESERVED' end)
          then raise exception 'Refund reservation consistency'; end if;
        return null;
      END;
      $gospaza$
      language plpgsql;
    `);
    this.addSql(`
      create constraint trigger refund_reservation_check after insert or update on financial_settlement
        deferrable initially deferred for each row execute function gospaza_refund_reservation_consistency();
    `);
  }
  async down(): Promise<void> { throw new Error("Financial history requires a forward migration."); }
}
