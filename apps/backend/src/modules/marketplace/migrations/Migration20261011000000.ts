import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261011000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`create table order_operation (
      id text primary key,
      medusa_order_id text not null unique,
      checkout_completion_id text not null unique references checkout_completion(id) on delete restrict,
      merchant_id text not null references merchant(id) on delete restrict,
      merchant_store_id text not null,
      status text not null default 'PENDING_ACCEPTANCE' check (status in ('PENDING_ACCEPTANCE', 'ACCEPTED', 'REJECTED')),
      revision integer not null default 0,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz null,
      foreign key (merchant_store_id, merchant_id) references merchant_store(id, merchant_id) on delete restrict,
      constraint order_operation_b_pending check (status = 'PENDING_ACCEPTANCE' and revision = 0)
    );`);
    this.addSql('create index "IDX_order_operation_tenant" on order_operation(merchant_id, merchant_store_id, created_at);');
    // Full uniqueness above retains identity even after soft deletion. C will
    // replace the pending-only CHECK with audited terminal-decision constraints.
    this.addSql(`create function gospaza_order_operation_guard() returns trigger language plpgsql as $$
    begin
      if TG_OP = 'UPDATE' and (new.id, new.medusa_order_id, new.checkout_completion_id, new.merchant_id, new.merchant_store_id, new.created_at)
        is distinct from (old.id, old.medusa_order_id, old.checkout_completion_id, old.merchant_id, old.merchant_store_id, old.created_at) then
        raise exception 'Order operation identity is immutable';
      end if;
      if TG_OP = 'INSERT' and not exists (
        select 1 from checkout_completion c join checkout_attempt a on a.id = c.checkout_attempt_id
        join delivery_reservation r on r.id = a.reservation_id join cart_marketplace_context x on x.id = a.cart_context_id
        where c.id = new.checkout_completion_id and c.order_id = new.medusa_order_id
          and c.state = 'SUCCEEDED' and c.native_state = 'done' and c.deleted_at is null
          and a.state = 'COMPLETED' and a.closed_at is not null and a.payment_accepted_at is not null and a.deleted_at is null
          and r.status = 'COMMITTED' and r.payment_accepted_at is not null and r.medusa_order_id = c.order_id and r.deleted_at is null
          and r.cart_context_id = x.id and r.merchant_store_id = new.merchant_store_id and x.deleted_at is null
          and x.merchant_id = new.merchant_id and x.merchant_store_id = new.merchant_store_id and x.medusa_cart_id = a.medusa_cart_id
          and c.terminal_receipt->>'order_id' = c.order_id and c.terminal_receipt->>'cart_id' = a.medusa_cart_id
          and a.snapshot->>'merchant_id' = new.merchant_id and a.snapshot->>'merchant_store_id' = new.merchant_store_id
          and a.snapshot->>'cart_context_id' = x.id and a.snapshot->>'reservation_id' = r.id
      ) then raise exception 'Successful checkout authority required'; end if;
      return new;
    end; $$;`);
    this.addSql('create trigger order_operation_guard before insert or update on order_operation for each row execute function gospaza_order_operation_guard();');
    // Infrastructure cursor, not an alternative operational/commercial model.
    this.addSql(`create table order_operation_repair_cursor (id text primary key check (id = 'completed-orders'), last_completion_id text null);
      insert into order_operation_repair_cursor(id) values ('completed-orders');`);
  }
  async down(): Promise<void> {
    this.addSql(`do $$ begin if exists (select 1 from order_operation) then raise exception 'M11 operational history requires an explicit forward migration'; end if; end; $$;`);
    this.addSql('drop table order_operation_repair_cursor;');
    this.addSql('drop table order_operation;');
    this.addSql('drop function gospaza_order_operation_guard();');
  }
}
