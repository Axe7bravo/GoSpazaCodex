import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261114120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`create table delivery_rescue_command (
      id text primary key, request_id text not null unique, actor_id text not null,
      delivery_id text not null references delivery_operation(id), fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
      prior_generation integer not null check(prior_generation>0), new_generation integer not null check(new_generation=prior_generation+1),
      prior_revision integer not null check(prior_revision>0), new_revision integer not null check(new_revision=prior_revision+1),
      prior_reason text not null check(prior_reason in ('POOL_EXHAUSTED','SEARCH_ENDED','SEARCH_UNAVAILABLE')),
      reason_code text not null check(reason_code='RETRY_DISPATCH_SEARCH'), configuration_revision integer not null check(configuration_revision>0),
      mode text not null check(mode in ('MERCHANT_ONLY','PLATFORM_ONLY','HYBRID')), recorded_at timestamptz not null,
      audit_type text not null default 'DELIVERY' check(audit_type='DELIVERY'),
      unique(delivery_id,prior_generation), unique(delivery_id,new_generation), unique(delivery_id,prior_revision),
      foreign key(audit_type,delivery_id,new_revision) references dispatch_event(target_type,target_id,revision) deferrable initially deferred,
      foreign key(delivery_id) references dispatch_work(delivery_id) deferrable initially deferred
    )`);
    // Replace only the original generation bounds, not unrelated state/timing checks.
    this.addSql(`do $gospaza$ declare constraint_row record; begin
      for constraint_row in select conname from pg_constraint where conrelid='delivery_operation'::regclass and contype='c'
        and (conname='delivery_generation_state' or pg_get_constraintdef(oid) ~ 'generation = ANY')
      loop execute format('alter table delivery_operation drop constraint %I',constraint_row.conname); end loop;
    end; $gospaza$`);
    this.addSql(`alter table delivery_operation add constraint delivery_generation_state check(
      (generation=0 and status in ('PENDING_DISPATCH','ATTENTION_REQUIRED')) or (generation>0 and status<>'PENDING_DISPATCH'))`);
    this.addSql(`create function gospaza_delivery_rescue_transition(previous_row delivery_operation, candidate_row delivery_operation)
      returns boolean as $gospaza$
      begin
        return coalesce(previous_row.status='ATTENTION_REQUIRED' and previous_row.generation>0
          and previous_row.reason in ('POOL_EXHAUSTED','SEARCH_ENDED','SEARCH_UNAVAILABLE')
          and candidate_row.status='SEARCHING' and candidate_row.generation=previous_row.generation+1
          and candidate_row.revision=previous_row.revision+1 and candidate_row.reason is null
          and candidate_row.restricted_content_present=previous_row.restricted_content_present
          and candidate_row.path=case when candidate_row.mode='PLATFORM_ONLY' then 'PLATFORM' else 'MERCHANT' end
          and exists(select 1 from store_dispatch_configuration configuration_row where configuration_row.merchant_store_id=previous_row.merchant_store_id
            and configuration_row.mode=candidate_row.mode and configuration_row.revision=candidate_row.configuration_revision and configuration_row.mode<>'DISABLED')
          and not previous_row.pickup_managed and previous_row.native_fulfillment_id is null and previous_row.picked_up_at is null
          and previous_row.arrived_at is null and previous_row.delivered_at is null and previous_row.tracking_generation is null and previous_row.handoff_failures=0
          and not candidate_row.pickup_managed and candidate_row.native_fulfillment_id is null and candidate_row.picked_up_at is null
          and candidate_row.arrived_at is null and candidate_row.delivered_at is null and candidate_row.tracking_generation is null and candidate_row.handoff_failures=0
          and not exists(select 1 from dispatch_commitment historical where historical.delivery_id=previous_row.id and
            (historical.generation>previous_row.generation or historical.status not in ('DECLINED','EXPIRED','CANCELLED')
             or historical.assigned_at is not null or historical.decided_at is null
             or not exists(select 1 from dispatch_event closure where closure.target_type='DELIVERY' and closure.target_id=previous_row.id
               and closure.action=historical.status and closure.evidence->>'commitment_id'=historical.id)))
          and not exists(select 1 from pickup_operation where delivery_id=previous_row.id)
          and not exists(select 1 from delivery_completion where delivery_id=previous_row.id)
          and not exists(select 1 from handoff_generation where delivery_id=previous_row.id)
          and not exists(select 1 from recipient_compliance where delivery_id=previous_row.id)
          and not exists(select 1 from restricted_return where delivery_id=previous_row.id)
          and not exists(select 1 from driver_compensation_snapshot where delivery_id=previous_row.id)
          and exists(select 1 from delivery_rescue_command command_row where command_row.delivery_id=previous_row.id
            and command_row.prior_generation=previous_row.generation and command_row.new_generation=candidate_row.generation
            and command_row.prior_revision=previous_row.revision and command_row.new_revision=candidate_row.revision
            and command_row.prior_reason=previous_row.reason and command_row.mode=candidate_row.mode
            and command_row.configuration_revision=candidate_row.configuration_revision and command_row.recorded_at=candidate_row.started_at), false);
      end;
      $gospaza$ language plpgsql`);
    // Preserve the installed M16/M17 extensions. Assert exact anchors before
    // changing only attention restart and same-generation immutability scope.
    this.addSql(`do $gospaza$ declare source_sql text; begin
      source_sql:=pg_get_functiondef('gospaza_dispatch_guard()'::regprocedure);
      if position('old.status=''ATTENTION_REQUIRED'' and new.status<>''RETURNED_TO_STORE''' in source_sql)=0
        or position('old.generation=1 and (' in source_sql)=0 then raise exception 'Unexpected dispatch guard version for M23'; end if;
      source_sql:=replace(source_sql,'old.status=''ATTENTION_REQUIRED'' and new.status<>''RETURNED_TO_STORE''',
        'old.status=''ATTENTION_REQUIRED'' and new.status<>''RETURNED_TO_STORE'' and not gospaza_delivery_rescue_transition(old,new)');
      source_sql:=replace(source_sql,'old.generation=1 and (','old.generation>0 and not gospaza_delivery_rescue_transition(old,new) and (');
      source_sql:=replace(source_sql,'new.generation<>1 or','new.generation<>old.generation or');
      execute source_sql;
    end; $gospaza$`);
    this.addSql(`create function gospaza_rescue_guard() returns trigger as $gospaza$
      declare source_row delivery_operation;
      begin
        if TG_TABLE_NAME='delivery_rescue_command' then
          if TG_OP<>'INSERT' then raise exception 'Rescue receipt is append only'; end if;
          select * into source_row from delivery_operation where id=NEW.delivery_id;
          if source_row.status is distinct from 'ATTENTION_REQUIRED' or source_row.revision is distinct from NEW.prior_revision
            or source_row.generation is distinct from NEW.prior_generation or source_row.reason is distinct from NEW.prior_reason
            then raise exception 'Rescue source mismatch'; end if;
        elsif TG_OP='INSERT' then
          if NEW.generation>1 then raise exception 'A new delivery cannot begin in a rescued generation'; end if;
        elsif NEW.generation<>OLD.generation then
          if not (OLD.generation=0 and NEW.generation=1 and OLD.status='PENDING_DISPATCH' and NEW.status='SEARCHING')
            and not gospaza_delivery_rescue_transition(OLD,NEW) then raise exception 'Rescue generation evidence required'; end if;
        end if;
        return NEW;
      end;
      $gospaza$ language plpgsql`);
    this.addSql(`create trigger delivery_rescue_receipt_guard before insert or update or delete on delivery_rescue_command for each row execute function gospaza_rescue_guard()`);
    this.addSql(`create trigger delivery_rescue_generation_guard before insert or update on delivery_operation for each row execute function gospaza_rescue_guard()`);
    this.addSql(`create function gospaza_rescue_consistency() returns trigger as $gospaza$
      declare target_delivery text; receipt_row delivery_rescue_command; current_row delivery_operation; work_row dispatch_work;
      begin
        if TG_TABLE_NAME='delivery_rescue_command' then target_delivery:=NEW.delivery_id; else target_delivery:=NEW.id; end if;
        select * into current_row from delivery_operation where id=target_delivery;
        for receipt_row in select * from delivery_rescue_command where delivery_id=target_delivery loop
          if current_row.generation<receipt_row.new_generation or current_row.revision<receipt_row.new_revision
            or not exists(select 1 from dispatch_event audit_row where audit_row.target_type='DELIVERY' and audit_row.target_id=target_delivery
              and audit_row.revision=receipt_row.new_revision and audit_row.action='SEARCH_REOPENED' and audit_row.actor_type='user'
              and audit_row.actor_id=receipt_row.actor_id and audit_row.occurred_at>=receipt_row.recorded_at
              and audit_row.evidence->>'rescue_id'=receipt_row.id and audit_row.evidence->>'request_id'=receipt_row.request_id
              and audit_row.evidence->>'reason_code'=receipt_row.reason_code and audit_row.evidence->>'prior_reason'=receipt_row.prior_reason
              and audit_row.evidence->>'mode'=receipt_row.mode and (audit_row.evidence->>'configuration_revision')::integer=receipt_row.configuration_revision
              and (audit_row.evidence->>'prior_revision')::integer=receipt_row.prior_revision
              and audit_row.evidence->>'from'='ATTENTION_REQUIRED' and audit_row.evidence->>'to'='SEARCHING'
              and (audit_row.evidence->>'prior_generation')::integer=receipt_row.prior_generation
              and (audit_row.evidence->>'new_generation')::integer=receipt_row.new_generation)
            then raise exception 'Rescue transition/audit mismatch'; end if;
          select * into work_row from dispatch_work where delivery_id=target_delivery;
          if not found or work_row.observed_revision is null or work_row.observed_revision<receipt_row.new_revision then raise exception 'Rescue work evidence missing'; end if;
          if current_row.revision=receipt_row.new_revision and (current_row.status<>'SEARCHING'
            or work_row.observed_revision is distinct from receipt_row.new_revision or work_row.scan_offset<>0 or work_row.last_error is not null
            or work_row.next_due_at>receipt_row.recorded_at) then raise exception 'Rescue due work mismatch'; end if;
        end loop;
        return null;
      end;
      $gospaza$ language plpgsql`);
    this.addSql(`create constraint trigger delivery_rescue_consistency after insert on delivery_rescue_command deferrable initially deferred for each row execute function gospaza_rescue_consistency()`);
    this.addSql(`create constraint trigger delivery_rescue_transition_consistency after update on delivery_operation deferrable initially deferred for each row execute function gospaza_rescue_consistency()`);
  }
  async down(): Promise<void> { throw new Error("Rescue generations and receipts cannot be destructively rolled back."); }
}
