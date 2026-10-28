import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20261026120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table restricted_delivery_document (
        id text primary key, order_operation_id text not null unique references order_operation(id), medusa_order_id text not null unique,
        snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null)
      );
      create table recipient_compliance (
        id text primary key, delivery_id text not null references delivery_operation(id), commitment_id text not null references dispatch_commitment(id),
        driver_profile_id text not null references driver_profile(id), generation_id text not null unique references handoff_generation(id),
        document_id text not null references restricted_delivery_document(id), outcome text not null check(outcome in ('SATISFIED','FAILED')),
        reason text check(reason in ('NO_ACCEPTABLE_ID','UNDER_MINIMUM_AGE','SCHOOL_GOING_LEARNER','SCHOOL_UNIFORM','APPARENT_INTOXICATION','RECIPIENT_REFUSED_VERIFICATION','DELIVERY_ADDRESS_MISMATCH','COMPLIANCE_RECOVERY_REQUIRED')),
        evidence jsonb not null check(jsonb_typeof(evidence)='object'), expected_revision integer not null, verified_at timestamptz not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        check((outcome='FAILED')=(reason is not null)),
        check(evidence-array['recipient_role','document_type','document_viewed','age_threshold_satisfied','school_uniform_observed','recipient_declares_school_going_learner','recipient_appears_intoxicated','recipient_refused_verification','invoice_address_matches','policy_version']='{}'::jsonb),
        check(outcome<>'SATISFIED' or (
          evidence->>'recipient_role' in ('PURCHASER','ALTERNATE_ADULT') and evidence->>'document_type' in ('IDENTITY_DOCUMENT','DRIVERS_LICENCE','PASSPORT')
          and evidence->'document_viewed'='true'::jsonb and evidence->'age_threshold_satisfied'='true'::jsonb
          and evidence->'school_uniform_observed'='false'::jsonb and evidence->'recipient_declares_school_going_learner'='false'::jsonb
          and evidence->'recipient_appears_intoxicated'='false'::jsonb and evidence->'recipient_refused_verification'='false'::jsonb
          and evidence->'invoice_address_matches'='true'::jsonb and evidence->>'policy_version'='FS-RECIPIENT-1') is true)
      );
      create table restricted_return (
        id text primary key, delivery_id text not null unique references delivery_operation(id), compliance_id text not null unique references recipient_compliance(id),
        commitment_id text not null unique references dispatch_commitment(id), merchant_store_id text not null references merchant_store(id),
        fulfillment_id text not null, physical_manifest jsonb not null check(jsonb_typeof(physical_manifest)='array'),
        state text not null check(state in ('RETURN_REQUIRED','RETURNING_TO_STORE','RETURNED_TO_STORE')),
        failed_at timestamptz not null, started_at timestamptz, driver_arrived_at timestamptz, returned_at timestamptz,
        received_by text references merchant_member(id), financial_review_required boolean not null default true check(financial_review_required),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz check(deleted_at is null),
        check((state='RETURNED_TO_STORE')=(returned_at is not null)),
        check(state<>'RETURNED_TO_STORE' or (started_at is not null and driver_arrived_at is not null and received_by is not null))
      );
      alter table delivery_operation drop constraint delivery_operation_status_check;
      alter table delivery_operation add constraint delivery_operation_status_check check(status in ('PENDING_DISPATCH','SEARCHING','OFFERED','ASSIGNED','ATTENTION_REQUIRED','DELIVERED','RETURNED_TO_STORE'));
      alter table dispatch_commitment drop constraint dispatch_commitment_status_check;
      alter table dispatch_commitment add constraint dispatch_commitment_status_check check(status in ('OFFERED','ASSIGNED','DECLINED','EXPIRED','CANCELLED','COMPLETED','RETURNED'));
      alter table dispatch_commitment drop constraint dispatch_assignment_receipt;
      alter table dispatch_commitment add constraint dispatch_assignment_receipt check((status in ('ASSIGNED','COMPLETED','RETURNED'))=(assigned_at is not null));
      do $$ declare src text; begin
        src:=pg_get_functiondef('gospaza_dispatch_guard()'::regprocedure);
        if position('old.status in (''ATTENTION_REQUIRED'',''DELIVERED'')' in src)=0 then raise exception 'Unexpected M16 dispatch guard'; end if;
        src:=replace(src,'old.status in (''ATTENTION_REQUIRED'',''DELIVERED'')','(old.status in (''DELIVERED'',''RETURNED_TO_STORE'') or (old.status=''ATTENTION_REQUIRED'' and new.status<>''RETURNED_TO_STORE''))');
        src:=replace(src,'new.status not in (''ASSIGNED'',''ATTENTION_REQUIRED'',''DELIVERED'')','new.status not in (''ASSIGNED'',''ATTENTION_REQUIRED'',''DELIVERED'',''RETURNED_TO_STORE'')');
        src:=replace(src,'old.status=''ASSIGNED'' and new.status=''COMPLETED''','old.status=''ASSIGNED'' and new.status in (''COMPLETED'',''RETURNED'')');
        execute src;
        src:=pg_get_functiondef('gospaza_pickup_consistency()'::regprocedure);
        if position('status in (''ASSIGNED'',''COMPLETED'')' in src)=0 then raise exception 'Unexpected M16 pickup guard'; end if;
        src:=replace(src,'status in (''ASSIGNED'',''COMPLETED'')','status in (''ASSIGNED'',''COMPLETED'',''RETURNED'')');
        src:=replace(src,'d.status not in (''ASSIGNED'',''ATTENTION_REQUIRED'',''DELIVERED'')','d.status not in (''ASSIGNED'',''ATTENTION_REQUIRED'',''DELIVERED'',''RETURNED_TO_STORE'')');
        execute src;
      end $$;
      create function gospaza_recipient_guard() returns trigger language plpgsql as $$ begin
        if TG_TABLE_NAME in ('recipient_compliance','restricted_delivery_document') then raise exception 'Immutable restricted evidence'; end if;
        if (new.id,new.delivery_id,new.compliance_id,new.commitment_id,new.merchant_store_id,new.fulfillment_id,new.physical_manifest,new.failed_at)
          is distinct from (old.id,old.delivery_id,old.compliance_id,old.commitment_id,old.merchant_store_id,old.fulfillment_id,old.physical_manifest,old.failed_at)
          or old.state='RETURNED_TO_STORE' or (old.started_at is not null and new.started_at is distinct from old.started_at)
          or (old.driver_arrived_at is not null and new.driver_arrived_at is distinct from old.driver_arrived_at)
          or not ((old.state='RETURN_REQUIRED' and new.state='RETURNING_TO_STORE') or (old.state='RETURNING_TO_STORE' and new.state in ('RETURNING_TO_STORE','RETURNED_TO_STORE')))
          then raise exception 'Immutable return custody'; end if;
        return new;
      end $$;
      create trigger recipient_immutable before update on recipient_compliance for each row execute function gospaza_recipient_guard();
      create trigger restricted_document_immutable before update on restricted_delivery_document for each row execute function gospaza_recipient_guard();
      create trigger restricted_return_guard before update on restricted_return for each row execute function gospaza_recipient_guard();
      create function gospaza_restricted_document_binding() returns trigger language plpgsql as $$ begin
        if not exists(select 1 from order_operation o where o.id=new.order_operation_id and o.medusa_order_id=new.medusa_order_id
          and new.snapshot->>'order_id'=o.medusa_order_id and new.snapshot->>'merchant_id'=o.merchant_id and new.snapshot->>'merchant_store_id'=o.merchant_store_id
          and new.snapshot->>'document_number'=new.id) then raise exception 'Restricted document order binding'; end if;
        return new;
      end $$;
      create trigger restricted_document_binding before insert on restricted_delivery_document for each row execute function gospaza_restricted_document_binding();
      create function gospaza_recipient_consistency() returns trigger language plpgsql as $$
      declare target text; d delivery_operation; c dispatch_commitment; r restricted_return; v recipient_compliance; begin
        if TG_TABLE_NAME='delivery_operation' then target:=new.id;
        elsif TG_TABLE_NAME in ('recipient_compliance','restricted_return','delivery_completion','dispatch_commitment') then target:=new.delivery_id;
        else raise exception 'Unsupported recipient consistency table'; end if;
        select * into d from delivery_operation where id=target;
        if not found then return null; end if;
        for v in select * from recipient_compliance where delivery_id=target loop
          if not d.restricted_content_present or d.arrived_at is null or not exists(select 1 from dispatch_commitment x where x.id=v.commitment_id and x.delivery_id=target and x.driver_profile_id=v.driver_profile_id)
            or not exists(select 1 from handoff_generation g where g.id=v.generation_id and g.delivery_id=target)
            or not exists(select 1 from restricted_delivery_document doc where doc.id=v.document_id and doc.order_operation_id=d.order_operation_id and doc.medusa_order_id=d.medusa_order_id)
            or not exists(select 1 from restricted_event e where e.target_id=v.id and e.action='RECIPIENT_'||v.outcome)
            then raise exception 'Recipient authority mismatch'; end if;
          if v.outcome='FAILED' and not exists(select 1 from restricted_return where compliance_id=v.id) then raise exception 'Failed handoff retains custody'; end if;
        end loop;
        select * into r from restricted_return where delivery_id=target;
        if r.id is not null then
          select * into c from dispatch_commitment where id=r.commitment_id;
          select * into v from recipient_compliance where id=r.compliance_id;
          if v.outcome is distinct from 'FAILED' or v.delivery_id<>target or v.commitment_id<>c.id or c.delivery_id<>target
            or r.merchant_store_id<>d.merchant_store_id or r.fulfillment_id is distinct from d.native_fulfillment_id
            or exists(select 1 from delivery_completion where delivery_id=target)
            or not exists(select 1 from pickup_operation p where p.delivery_id=target and p.action='SHIP' and p.state='SUCCEEDED' and p.input->'items'=r.physical_manifest)
            then raise exception 'Return authority mismatch'; end if;
          if r.state='RETURNED_TO_STORE' then
            if c.status<>'RETURNED' or d.status<>'RETURNED_TO_STORE' or not exists(select 1 from merchant_member m where m.id=r.received_by and m.merchant_id=d.merchant_id)
              or not exists(select 1 from restricted_event e where e.target_id=r.id and e.action='STORE_RECEIPT_ACKNOWLEDGED' and e.actor_id=r.received_by)
              or not exists(select 1 from dispatch_event e where e.target_id=target and e.action='RETURNED_TO_STORE' and e.revision=d.revision)
              then raise exception 'Two-sided return receipt required'; end if;
          elsif c.status<>'ASSIGNED' or d.status not in ('ASSIGNED','ATTENTION_REQUIRED') then raise exception 'Return must retain driver capacity'; end if;
        elsif d.status='RETURNED_TO_STORE' or exists(select 1 from dispatch_commitment where delivery_id=target and status='RETURNED') then raise exception 'Return receipt required'; end if;
        if d.restricted_content_present and exists(select 1 from delivery_completion o where o.delivery_id=target and not exists
          (select 1 from recipient_compliance v where v.delivery_id=target and v.commitment_id=o.commitment_id and v.generation_id=o.generation_id and v.outcome='SATISFIED'))
          then raise exception 'Restricted completion requires recipient evidence'; end if;
        return null;
      end $$;
      create constraint trigger recipient_consistency after insert on recipient_compliance deferrable initially deferred for each row execute function gospaza_recipient_consistency();
      create constraint trigger restricted_return_consistency after insert or update on restricted_return deferrable initially deferred for each row execute function gospaza_recipient_consistency();
      create constraint trigger restricted_delivery_consistency after update on delivery_operation deferrable initially deferred for each row execute function gospaza_recipient_consistency();
      create constraint trigger restricted_commitment_consistency after update on dispatch_commitment deferrable initially deferred for each row execute function gospaza_recipient_consistency();
      create constraint trigger restricted_completion_consistency after insert or update on delivery_completion deferrable initially deferred for each row execute function gospaza_recipient_consistency();
    `);
  }
  async down(): Promise<void> { throw new Error("Restricted custody evidence requires a forward migration."); }
}
