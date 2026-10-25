import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20261022000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table delivery_operation add column pickup_managed boolean not null default false,
        add column native_fulfillment_id text, add column picked_up_at timestamptz;
      create unique index delivery_native_fulfillment_unique on delivery_operation(native_fulfillment_id) where native_fulfillment_id is not null;
      create table pickup_operation (
        id text primary key, delivery_id text not null references delivery_operation(id), action text not null check(action in ('PREPARE','SHIP')),
        state text not null check(state in ('DISPATCHED','SUCCEEDED','RECOVERY_REQUIRED')),
        workflow_id text not null, transaction_id text not null unique, input jsonb not null check(jsonb_typeof(input)='object'),
        input_fingerprint text not null, dispatched_at timestamptz not null, native_state text, execution_id text, run_id text,
        fulfillment_id text, terminal_receipt jsonb,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        unique(delivery_id,action), check(state<>'SUCCEEDED' or (native_state is not distinct from 'done' and fulfillment_id is not null and terminal_receipt is not null))
      );
      create table pickup_work (delivery_id text primary key references delivery_operation(id), next_due_at timestamptz not null default now());
      create index pickup_work_due on pickup_work(next_due_at,delivery_id);
      create function gospaza_pickup_guard() returns trigger language plpgsql as $$ begin
        if TG_TABLE_NAME='pickup_operation' then
          if TG_OP='INSERT' and new.state<>'DISPATCHED' then raise exception 'Pickup begins dispatched'; end if;
          if TG_OP='UPDATE' and (old.state='SUCCEEDED' or
            (old.state='RECOVERY_REQUIRED' and new.state='DISPATCHED') or
            (new.id,new.delivery_id,new.action,new.workflow_id,new.transaction_id,new.input,new.input_fingerprint,new.dispatched_at)
            is distinct from (old.id,old.delivery_id,old.action,old.workflow_id,old.transaction_id,old.input,old.input_fingerprint,old.dispatched_at)
            or (old.native_state='done' and new.native_state is distinct from 'done')
            or (old.fulfillment_id is not null and new.fulfillment_id is distinct from old.fulfillment_id)
            or (old.run_id is not null and new.run_id is distinct from old.run_id)
            or (old.execution_id is not null and new.execution_id is distinct from old.execution_id)) then raise exception 'Immutable pickup operation'; end if;
        else
          if old.pickup_managed and not new.pickup_managed then raise exception 'Pickup handoff irreversible'; end if;
          if (old.native_fulfillment_id is not null and new.native_fulfillment_id is distinct from old.native_fulfillment_id)
            or (old.picked_up_at is not null and new.picked_up_at is distinct from old.picked_up_at) then raise exception 'Immutable pickup receipt'; end if;
        end if;
        return new;
      end $$;
      create trigger pickup_operation_guard before insert or update on pickup_operation for each row execute function gospaza_pickup_guard();
      create trigger pickup_delivery_guard before update on delivery_operation for each row execute function gospaza_pickup_guard();
      create function gospaza_pickup_consistency() returns trigger language plpgsql as $$
      declare d delivery_operation; c dispatch_commitment; op pickup_operation; target text;
      begin
        if TG_TABLE_NAME='pickup_operation' then target:=new.delivery_id; else target:=new.id; end if;
        select * into d from delivery_operation where id=target;
        if not d.pickup_managed then
          if TG_TABLE_NAME='pickup_operation' or d.native_fulfillment_id is not null or d.picked_up_at is not null then raise exception 'Pickup lifecycle owner missing'; end if;
          return null;
        end if;
        select * into c from dispatch_commitment where delivery_id=target and status='ASSIGNED';
        if c.id is null or d.status not in ('ASSIGNED','ATTENTION_REQUIRED') then raise exception 'Pickup requires occupied assignment'; end if;
        for op in select * from pickup_operation where delivery_id=target loop
          if (op.input->>'order_id') is distinct from d.medusa_order_id or (op.input->>'commitment_id') is distinct from c.id or (op.input->>'driver_profile_id') is distinct from c.driver_profile_id
            then raise exception 'Pickup authority mismatch'; end if;
          if not exists(select 1 from dispatch_event where target_id=target and evidence->>'operation_id'=op.id)
            then raise exception 'Pickup operation audit missing'; end if;
          if op.action='SHIP' and not exists(select 1 from pickup_operation p where p.delivery_id=target and p.action='PREPARE'
            and p.state='SUCCEEDED' and p.fulfillment_id=d.native_fulfillment_id and p.fulfillment_id=op.input->>'fulfillment_id')
            then raise exception 'Shipment requires verified preparation'; end if;
        end loop;
        if d.native_fulfillment_id is not null and not exists(select 1 from pickup_operation where delivery_id=target and action='PREPARE'
          and state='SUCCEEDED' and fulfillment_id=d.native_fulfillment_id) then raise exception 'Pickup fulfillment receipt missing'; end if;
        if d.picked_up_at is not null and (d.native_fulfillment_id is null or not exists(select 1 from pickup_operation where delivery_id=target
          and action='SHIP' and state='SUCCEEDED' and fulfillment_id=d.native_fulfillment_id)) then raise exception 'Pickup shipment receipt missing'; end if;
        return null;
      end $$;
      create constraint trigger pickup_operation_consistency after insert or update on pickup_operation deferrable initially deferred for each row execute function gospaza_pickup_consistency();
      create constraint trigger pickup_delivery_consistency after insert or update on delivery_operation deferrable initially deferred for each row execute function gospaza_pickup_consistency();
    `);
  }
  async down(): Promise<void> {
    this.addSql(`drop trigger pickup_delivery_consistency on delivery_operation; drop trigger pickup_delivery_guard on delivery_operation;
      drop table pickup_work,pickup_operation; drop function gospaza_pickup_consistency(); drop function gospaza_pickup_guard();
      drop index delivery_native_fulfillment_unique; alter table delivery_operation drop column pickup_managed, drop column native_fulfillment_id, drop column picked_up_at;`);
  }
}
