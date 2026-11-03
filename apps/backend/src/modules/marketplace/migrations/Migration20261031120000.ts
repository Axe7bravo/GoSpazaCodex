import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261031120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`create table store_credit_operation (
      id text primary key, adjustment_id text not null unique references financial_adjustment(id),
      settlement_id text not null unique references financial_settlement(id), order_id text not null,
      customer_id text not null, store_id text not null, amount_minor bigint not null check(amount_minor>0),
      currency text not null check(currency='zar'), account_id text, native_transaction_id text unique,
      status text not null check(status in ('CREATED','ISSUING','SETTLED','FAILED','ATTENTION_REQUIRED')),
      revision integer not null default 1, attention_reason text, settled_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      check ((status='SETTLED')=(settled_at is not null)), check((status='SETTLED')=(native_transaction_id is not null)),
      check(status not in ('ISSUING','SETTLED') or account_id is not null)
    );`);
    this.addSql(`create table store_credit_operation_event (
      operation_id text not null references store_credit_operation(id), revision integer not null,
      status text not null, actor_id text not null, occurred_at timestamptz not null default now(),
      primary key(operation_id,revision)
    );`);
    this.addSql(`create function gospaza_credit_operation_guard() returns trigger as $credit$
      begin
        if TG_OP='DELETE' then raise exception 'Credit operation history immutable'; end if;
        if TG_OP='INSERT' and (NEW.revision<>1 or NEW.status<>'CREATED') then raise exception 'Credit initial state'; end if;
        if TG_OP='UPDATE' and (
          (to_jsonb(NEW)-array['status','revision','attention_reason','account_id','native_transaction_id','updated_at','settled_at'])
          is distinct from (to_jsonb(OLD)-array['status','revision','attention_reason','account_id','native_transaction_id','updated_at','settled_at'])
          or OLD.status in ('SETTLED','FAILED') or NEW.revision<>OLD.revision+1
          or (OLD.account_id is not null and OLD.account_id is distinct from NEW.account_id)
          or (OLD.native_transaction_id is not null and OLD.native_transaction_id is distinct from NEW.native_transaction_id)
          or (NEW.status='SETTLED' and OLD.status not in ('ISSUING','ATTENTION_REQUIRED'))
        ) then raise exception 'Immutable credit operation'; end if;
        if not exists(select 1 from financial_settlement s join financial_adjustment a on a.id=s.adjustment_id
          where s.id=NEW.settlement_id and s.method='STORE_CREDIT' and s.adjustment_id=NEW.adjustment_id
            and a.status='APPROVED' and a.customer_id=NEW.customer_id and a.medusa_order_id=NEW.order_id
            and a.merchant_store_id=NEW.store_id and s.amount_minor=NEW.amount_minor and a.currency=NEW.currency)
          then raise exception 'Credit source mismatch'; end if;
        return NEW;
      end;
      $credit$ language plpgsql;`);
    this.addSql(`create trigger credit_operation_guard before insert or update or delete on store_credit_operation
      for each row execute function gospaza_credit_operation_guard();`);
    this.addSql(`create trigger credit_event_immutable before update or delete on store_credit_operation_event
      for each row execute function gospaza_refund_audit_guard();`);
    this.addSql(`create function gospaza_credit_consistency() returns trigger as $credit$
      declare op store_credit_operation; reservation financial_settlement;
      begin
        if TG_TABLE_NAME='financial_settlement' then
          select * into op from store_credit_operation where settlement_id=NEW.id;
          if not found and NEW.method<>'STORE_CREDIT' then return null; end if;
        else
          select * into strict op from store_credit_operation where id=NEW.id;
          if not exists(select 1 from store_credit_operation_event e where e.operation_id=NEW.id and e.revision=NEW.revision
            and e.status=NEW.status) then raise exception 'Credit audit required'; end if;
        end if;
        select * into strict reservation from financial_settlement where id=op.settlement_id;
        if reservation.state<>(case op.status when 'SETTLED' then 'SETTLED' when 'FAILED' then 'RELEASED' else 'RESERVED' end)
          then raise exception 'Credit reservation consistency'; end if;
        if op.status='SETTLED' and not exists(
          select 1 from store_credit_account_transaction credit_row
          join store_credit_account account_row on account_row.id=credit_row.account_id
          where credit_row.id=op.native_transaction_id and credit_row.account_id=op.account_id
            and credit_row.type='credit' and credit_row.amount*100=op.amount_minor
            and credit_row.reference='gospaza-financial-settlement' and credit_row.reference_id=op.id
            and credit_row.deleted_at is null and account_row.deleted_at is null
            and account_row.customer_id=op.customer_id and account_row.currency_code=op.currency
        ) then raise exception 'Native credit evidence required'; end if;
        return null;
      end;
      $credit$ language plpgsql;`);
    this.addSql(`create constraint trigger credit_consistency_check after insert or update on store_credit_operation
      deferrable initially deferred for each row execute function gospaza_credit_consistency();`);
    this.addSql(`create constraint trigger credit_reservation_check after insert or update on financial_settlement
      deferrable initially deferred for each row execute function gospaza_credit_consistency();`);
  }
  async down(): Promise<void> { throw new Error("Financial history requires a forward migration."); }
}
