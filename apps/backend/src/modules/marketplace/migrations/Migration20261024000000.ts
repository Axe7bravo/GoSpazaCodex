import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20261024000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table delivery_operation add column arrived_at timestamptz, add column delivered_at timestamptz,
        add column handoff_failures integer not null default 0 check(handoff_failures between 0 and 15), add column tracking_generation text;
      alter table delivery_operation drop constraint delivery_operation_status_check;
      alter table delivery_operation add constraint delivery_operation_status_check check(status in ('PENDING_DISPATCH','SEARCHING','OFFERED','ASSIGNED','ATTENTION_REQUIRED','DELIVERED'));
      alter table delivery_operation add constraint delivery_handoff_timestamp check((status='DELIVERED')=(delivered_at is not null));
      alter table dispatch_commitment drop constraint dispatch_commitment_status_check;
      alter table dispatch_commitment add constraint dispatch_commitment_status_check check(status in ('OFFERED','ASSIGNED','DECLINED','EXPIRED','CANCELLED','COMPLETED'));
      do $$ declare n text; begin
        select conname into n from pg_constraint where conrelid='dispatch_commitment'::regclass and contype='c' and pg_get_constraintdef(oid) like '%assigned_at%';
        if n is null then raise exception 'Assigned timestamp constraint missing'; end if;
        execute format('alter table dispatch_commitment drop constraint %I',n);
      end $$;
      alter table dispatch_commitment add constraint dispatch_assignment_receipt check((status in ('ASSIGNED','COMPLETED'))=(assigned_at is not null));
      create table handoff_generation (
        id text primary key, delivery_id text not null references delivery_operation(id), number integer not null check(number between 1 and 3),
        nonce text not null, key_id text not null, state text not null check(state in ('ACTIVE','SUPERSEDED','EXHAUSTED','CONSUMED')),
        failed_attempts integer not null default 0 check(failed_attempts between 0 and 5), expires_at timestamptz not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        unique(delivery_id,number), check(expires_at>created_at)
      );
      create unique index handoff_one_active on handoff_generation(delivery_id) where state='ACTIVE';
      create table handoff_rate (
        delivery_id text not null references delivery_operation(id), scope text not null, started_at timestamptz not null,
        count integer not null check(count between 1 and 60), primary key(delivery_id,scope)
      );
      create table delivery_completion (
        id text primary key, delivery_id text not null unique references delivery_operation(id), commitment_id text not null references dispatch_commitment(id),
        generation_id text not null unique references handoff_generation(id), ship_operation_id text not null references pickup_operation(id),
        workflow_id text not null, transaction_id text not null unique, state text not null check(state in ('DISPATCHED','RECOVERY_REQUIRED','SUCCEEDED')),
        dispatched_at timestamptz not null, native_done boolean not null default false, receipt jsonb, next_due_at timestamptz not null default now(),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        check(state<>'SUCCEEDED' or (native_done and receipt is not null))
      );
      create index delivery_completion_due on delivery_completion(next_due_at) where state<>'SUCCEEDED';
      -- Extend the existing guards, retaining their other M15/M16-B rules verbatim.
      do $$ declare src text; begin
        src:=pg_get_functiondef('gospaza_dispatch_guard()'::regprocedure);
        if position('old.status=''ATTENTION_REQUIRED'' or (old.status=''ASSIGNED'' and new.status not in (''ASSIGNED'',''ATTENTION_REQUIRED''))' in src)=0
          or position('old.status<>''OFFERED'' or new.status=''OFFERED'' or' in src)=0
          then raise exception 'Unexpected dispatch guard version'; end if;
        src:=replace(src, 'old.status=''ATTENTION_REQUIRED'' or (old.status=''ASSIGNED'' and new.status not in (''ASSIGNED'',''ATTENTION_REQUIRED''))',
          'old.status in (''ATTENTION_REQUIRED'',''DELIVERED'') or (old.status=''ASSIGNED'' and new.status not in (''ASSIGNED'',''ATTENTION_REQUIRED'',''DELIVERED''))');
        src:=replace(src, 'old.status<>''OFFERED'' or new.status=''OFFERED'' or',
          '(old.status<>''OFFERED'' and not (old.status=''ASSIGNED'' and new.status=''COMPLETED'')) or new.status=''OFFERED'' or');
        execute src;
        src:=pg_get_functiondef('gospaza_pickup_consistency()'::regprocedure);
        if position('delivery_id=target and status=''ASSIGNED''' in src)=0
          or position('d.status not in (''ASSIGNED'',''ATTENTION_REQUIRED'')' in src)=0
          then raise exception 'Unexpected pickup guard version'; end if;
        src:=replace(src, 'delivery_id=target and status=''ASSIGNED''', 'delivery_id=target and status in (''ASSIGNED'',''COMPLETED'')');
        src:=replace(src, 'd.status not in (''ASSIGNED'',''ATTENTION_REQUIRED'')', 'd.status not in (''ASSIGNED'',''ATTENTION_REQUIRED'',''DELIVERED'')');
        execute src;
      end $$;
      create function gospaza_handoff_guard() returns trigger language plpgsql as $$ begin
        if TG_TABLE_NAME='handoff_generation' then
          if TG_OP='UPDATE' and ((new.id,new.delivery_id,new.number,new.nonce,new.key_id,new.created_at,new.expires_at) is distinct from
            (old.id,old.delivery_id,old.number,old.nonce,old.key_id,old.created_at,old.expires_at) or new.failed_attempts<old.failed_attempts
            or old.state<>'ACTIVE' and new.state<>old.state) then raise exception 'Immutable handoff generation'; end if;
        elsif TG_TABLE_NAME='delivery_completion' then
          if TG_OP='INSERT' and new.state<>'DISPATCHED' then raise exception 'Completion begins dispatched'; end if;
          if TG_OP='UPDATE' and (old.state='SUCCEEDED' or old.state='RECOVERY_REQUIRED' and new.state='DISPATCHED'
            or old.native_done and not new.native_done
            or (new.id,new.delivery_id,new.commitment_id,new.generation_id,new.ship_operation_id,new.workflow_id,new.transaction_id,new.dispatched_at)
              is distinct from (old.id,old.delivery_id,old.commitment_id,old.generation_id,old.ship_operation_id,old.workflow_id,old.transaction_id,old.dispatched_at)) then raise exception 'Immutable delivery completion'; end if;
        else
          if new.handoff_failures<old.handoff_failures or old.arrived_at is not null and new.arrived_at is distinct from old.arrived_at
            or old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at then raise exception 'Immutable handoff receipt'; end if;
          if new.arrived_at is not null and new.picked_up_at is null then raise exception 'Arrival requires pickup'; end if;
        end if;
        return new;
      end $$;
      create trigger handoff_generation_guard before update on handoff_generation for each row execute function gospaza_handoff_guard();
      create trigger delivery_completion_guard before insert or update on delivery_completion for each row execute function gospaza_handoff_guard();
      create trigger delivery_handoff_guard before update on delivery_operation for each row execute function gospaza_handoff_guard();
      create function gospaza_handoff_consistency() returns trigger language plpgsql as $$
      declare target text; d delivery_operation; c dispatch_commitment; op delivery_completion; begin
        target:=case when TG_TABLE_NAME='delivery_operation' then new.id else new.delivery_id end;
        select * into d from delivery_operation where id=target;
        select * into op from delivery_completion where delivery_id=target;
        if op.id is not null then
          select * into c from dispatch_commitment where id=op.commitment_id;
          if c.delivery_id is distinct from target or c.status not in ('ASSIGNED','COMPLETED') or not exists
            (select 1 from handoff_generation g where g.id=op.generation_id and g.delivery_id=target and g.state='CONSUMED')
            or not exists(select 1 from pickup_operation p where p.id=op.ship_operation_id and p.delivery_id=target and p.action='SHIP' and p.state='SUCCEEDED')
            then raise exception 'Completion authority mismatch'; end if;
        end if;
        if d.status='DELIVERED' or exists(select 1 from dispatch_commitment where delivery_id=target and status='COMPLETED') then
          if d.status<>'DELIVERED' or d.delivered_at is null or d.arrived_at is null or op.id is null or op.state<>'SUCCEEDED'
            or c.status<>'COMPLETED' or op.receipt->>'fulfillment_id' is distinct from d.native_fulfillment_id
            or exists(select 1 from dispatch_commitment where delivery_id=target and status in ('ASSIGNED','OFFERED'))
            or not exists(select 1 from dispatch_event where target_id=target and action='DELIVERED' and revision=d.revision)
            then raise exception 'Delivery completion receipt required'; end if;
        end if;
        return null;
      end $$;
      create constraint trigger handoff_completion_consistency after insert or update on delivery_completion deferrable initially deferred for each row execute function gospaza_handoff_consistency();
      create constraint trigger handoff_delivery_consistency after update on delivery_operation deferrable initially deferred for each row execute function gospaza_handoff_consistency();
      create constraint trigger handoff_commitment_consistency after update on dispatch_commitment deferrable initially deferred for each row execute function gospaza_handoff_consistency();
    `);
  }
  async down(): Promise<void> { throw new Error("Handoff receipts must be retained; rollback requires an explicit data-preserving migration."); }
}
