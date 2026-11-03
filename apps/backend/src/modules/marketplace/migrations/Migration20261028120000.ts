import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261028120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table financial_adjustment (
        id text primary key, order_operation_id text not null references order_operation(id),
        medusa_order_id text not null, merchant_id text not null references merchant(id), merchant_store_id text not null references merchant_store(id), customer_id text,
        source_type text not null, source_id text not null, source_revision integer not null check(source_revision>=0),
        reason text not null check(reason in ('ITEM_OMITTED','MERCHANT_REJECTED','FULL_UNFULFILLABLE','RESTRICTED_HANDOFF_FAILED','GOODWILL')),
        financial_cause text not null check(financial_cause in ('MERCHANT','PLATFORM','CUSTOMER_RECIPIENT','POLICY')),
        currency text not null default 'zar' check(currency='zar'), amount_minor bigint not null check(amount_minor between 0 and 9007199254740991),
        economic_bound_minor bigint not null check(economic_bound_minor between 0 and 9007199254740991),
        allocations jsonb not null check(jsonb_typeof(allocations)='array'), economics_fingerprint text not null,
        eligible_methods jsonb not null, default_method text not null check(default_method in ('STORE_CREDIT','ORIGINAL_PAYMENT')),
        status text not null check(status in ('REVIEW_REQUIRED','APPROVED','ATTENTION_REQUIRED')), revision integer not null default 1 check(revision>0),
        approved_at timestamptz, approved_by text, source_review_required boolean not null default true, policy_version text not null, request_fingerprint text not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        unique(source_type,source_id,source_revision,reason),
        check(eligible_methods=jsonb_build_array(default_method)),
        check((status='APPROVED')=(approved_at is not null)), check(deleted_at is null)
      );
      create index IDX_financial_adjustment_tenant on financial_adjustment(merchant_id,merchant_store_id,medusa_order_id);
      create table financial_adjustment_event (
        id text primary key, adjustment_id text not null references financial_adjustment(id), action text not null,
        actor_type text not null check(actor_type in ('system','user')), actor_id text, revision integer not null,
        evidence jsonb not null, occurred_at timestamptz not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        unique(adjustment_id,revision), check(deleted_at is null)
      );
      create function gospaza_financial_guard() returns trigger language plpgsql as $$
      declare operation_row order_operation; allocation_row jsonb; sum_minor numeric:=0; previous_row financial_adjustment;
      begin
        if TG_OP='DELETE' then raise exception 'Financial history is append only' using errcode='23514'; end if;
        select * into operation_row from order_operation where id=new.order_operation_id for update;
        if operation_row.id is null or operation_row.medusa_order_id<>new.medusa_order_id or operation_row.merchant_id<>new.merchant_id or operation_row.merchant_store_id<>new.merchant_store_id then
          raise exception 'Financial order scope' using errcode='23514'; end if;
        if TG_OP='UPDATE' and (
          (to_jsonb(new)-array['status','revision','approved_at','approved_by','updated_at']) is distinct from
          (to_jsonb(old)-array['status','revision','approved_at','approved_by','updated_at'])
          or old.status<>'REVIEW_REQUIRED' or new.status<>'APPROVED' or new.revision<>old.revision+1
        ) then raise exception 'Immutable financial economics' using errcode='23514'; end if;
        for allocation_row in select value from jsonb_array_elements(new.allocations) loop
          if jsonb_typeof(allocation_row)<>'object' or not (allocation_row ?& array['component','economic_key','start_unit','end_unit','amount_minor'])
            or allocation_row->>'component' not in ('MERCHANDISE','TAX','DELIVERY_FEE','GOODWILL')
            or jsonb_typeof(allocation_row->'amount_minor')<>'number' or jsonb_typeof(allocation_row->'start_unit')<>'number' or jsonb_typeof(allocation_row->'end_unit')<>'number'
            or not (allocation_row->>'amount_minor' ~ '^[0-9]+$')
            or not (allocation_row->>'start_unit' ~ '^[0-9]+$') or not (allocation_row->>'end_unit' ~ '^[0-9]+$')
            or (allocation_row->>'end_unit')::numeric <= (allocation_row->>'start_unit')::numeric
            or coalesce(allocation_row->>'economic_key','')='' then raise exception 'Invalid financial allocation' using errcode='23514'; end if;
          sum_minor:=sum_minor+(allocation_row->>'amount_minor')::numeric;
        end loop;
        if sum_minor<>new.amount_minor then raise exception 'Financial allocation sum' using errcode='23514'; end if;
        if exists(select 1 from jsonb_array_elements(new.allocations) with ordinality as left_part(value,position),
          jsonb_array_elements(new.allocations) with ordinality as right_part(value,position)
          where left_part.position<right_part.position and left_part.value->>'component'=right_part.value->>'component'
            and left_part.value->>'economic_key'=right_part.value->>'economic_key'
            and (left_part.value->>'start_unit')::numeric<(right_part.value->>'end_unit')::numeric
            and (right_part.value->>'start_unit')::numeric<(left_part.value->>'end_unit')::numeric)
          then raise exception 'Financial entitlement overlap' using errcode='23514'; end if;
        if exists(select 1 from financial_adjustment existing, jsonb_array_elements(existing.allocations) prior_component, jsonb_array_elements(new.allocations) next_component
          where existing.order_operation_id=new.order_operation_id and existing.id<>new.id
            and prior_component->>'component'=next_component->>'component' and prior_component->>'economic_key'=next_component->>'economic_key'
            and (prior_component->>'start_unit')::numeric < (next_component->>'end_unit')::numeric
            and (next_component->>'start_unit')::numeric < (prior_component->>'end_unit')::numeric)
          then raise exception 'Financial entitlement overlap' using errcode='23514'; end if;
        select * into previous_row from financial_adjustment where order_operation_id=new.order_operation_id and id<>new.id limit 1;
        if previous_row.id is not null and (previous_row.economics_fingerprint<>new.economics_fingerprint or previous_row.economic_bound_minor<>new.economic_bound_minor)
          then raise exception 'Financial economics changed' using errcode='23514'; end if;
        if new.amount_minor + coalesce((select sum(amount_minor) from financial_adjustment where order_operation_id=new.order_operation_id and id<>new.id),0)>new.economic_bound_minor
          then raise exception 'Financial economic bound' using errcode='23514'; end if;
        return new;
      end $$;
      create trigger financial_guard before insert or update or delete on financial_adjustment for each row execute function gospaza_financial_guard();
      create function gospaza_financial_audit_check() returns trigger language plpgsql as $$
      begin
        if not exists(select 1 from financial_adjustment_event e where e.adjustment_id=new.id and e.revision=new.revision
          and e.evidence->>'status'=new.status and (e.evidence->>'amount_minor')::numeric=new.amount_minor)
          then raise exception 'Financial audit required' using errcode='23514'; end if;
        return null;
      end $$;
      create constraint trigger financial_audit_check after insert or update on financial_adjustment deferrable initially deferred for each row execute function gospaza_financial_audit_check();
      create function gospaza_financial_event_immutable() returns trigger language plpgsql as $$
      begin raise exception 'Financial audit append only' using errcode='23514'; end $$;
      create trigger financial_event_immutable before update or delete on financial_adjustment_event for each row execute function gospaza_financial_event_immutable();
    `);
  }
  async down(): Promise<void> { throw new Error("Financial history requires a forward migration."); }
}
