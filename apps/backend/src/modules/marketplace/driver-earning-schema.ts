// Finance owns these rows. M16/M17 retain native fulfillment/completion ownership.
// One SQL source validator is shared by recognition and database insert guards.
export const driverEarningSql = [
  `create table driver_earning_recognition (
    id text primary key, delivery_id text not null unique references delivery_operation(id),
    completion_id text not null unique references delivery_completion(id), commitment_id text not null unique references dispatch_commitment(id),
    driver_profile_id text not null references driver_profile(id), snapshot_id text not null references driver_compensation_snapshot(id),
    outcome text not null check(outcome in ('EARNED','NON_GOSPAZA_PAYABLE')), source_fingerprint text not null,
    policy_version text not null check(policy_version='M21_C_V1'), recorded_at timestamptz not null default clock_timestamp())`,
  `create table driver_earning (
    id text primary key, recognition_id text not null unique references driver_earning_recognition(id),
    driver_profile_id text not null references driver_profile(id), delivery_id text not null unique references delivery_operation(id),
    order_id text not null unique, commitment_id text not null unique references dispatch_commitment(id),
    completion_id text not null unique references delivery_completion(id), merchant_id text not null references merchant(id),
    store_id text not null references merchant_store(id), payer_classification text not null check(payer_classification='PLATFORM'),
    payer text not null check(payer='GOSPAZA'), earning_type text not null check(earning_type='SUCCESSFUL_DELIVERY'),
    amount_minor bigint not null check(amount_minor between 1 and 9007199254740991), currency text not null check(currency='zar'),
    snapshot_id text not null references driver_compensation_snapshot(id), terms_id text not null references driver_compensation_terms(id),
    terms_revision integer not null, terms_policy_version text not null, policy_version text not null check(policy_version='M21_C_V1'),
    event_id text not null references dispatch_event(id), source_revision integer not null check(source_revision>0),
    economic_at timestamptz not null, recorded_at timestamptz not null default clock_timestamp(), source_fingerprint text not null)`,
  `create table driver_earning_exception (
    id text primary key, delivery_id text not null references delivery_operation(id),
    commitment_id text references dispatch_commitment(id), completion_id text references delivery_completion(id),
    driver_profile_id text references driver_profile(id), source_id text not null,
    reason text not null check(reason in ('COMPLETION_EVIDENCE_MISMATCH','SNAPSHOT_MISSING','SNAPSHOT_IDENTITY_MISMATCH','PAYER_CLASSIFICATION_CONFLICT','SOURCE_CONFLICT')),
    first_evidence jsonb not null, recorded_at timestamptz not null default clock_timestamp(), unique(delivery_id,reason,source_id))`,
  `create table driver_earning_audit (
    id text primary key, kind text not null check(kind in ('RECOGNITION','EARNING','EXCEPTION')), target_id text not null,
    source_fingerprint text not null, recorded_at timestamptz not null default clock_timestamp(), unique(kind,target_id))`,
  `create function gospaza_driver_earning_source(target text) returns jsonb as $m21c$
    declare delivery_row delivery_operation; completion_row delivery_completion; commitment_row dispatch_commitment;
      ship_row pickup_operation; prepare_row pickup_operation; snapshot_row driver_compensation_snapshot; event_row dispatch_event;
      context_json jsonb; recipient_id text; activation_id text; fingerprint text; native_proof_id text;
    begin
      select * into delivery_row from delivery_operation where id=target and deleted_at is null;
      if not found then return jsonb_build_object('state','NO_DELIVERY'); end if;
      select * into completion_row from delivery_completion where delivery_id=target and deleted_at is null;
      select * into commitment_row from dispatch_commitment where id=completion_row.commitment_id;
      context_json:=jsonb_build_object('delivery_id',target,'order_id',delivery_row.medusa_order_id,
        'completion_id',completion_row.id,'commitment_id',commitment_row.id,'driver_profile_id',commitment_row.driver_profile_id);
      if exists(select 1 from restricted_return rr where rr.delivery_id=target and rr.deleted_at is null) then
        if completion_row.id is null and delivery_row.status<>'DELIVERED' then
          return context_json||jsonb_build_object('state','NO_ORDINARY_EARNING','reason','RESTRICTED_RETURN');
        end if;
        return context_json||jsonb_build_object('state','UNRESOLVED','reason','COMPLETION_EVIDENCE_MISMATCH');
      end if;
      if delivery_row.status<>'DELIVERED' then return context_json||jsonb_build_object('state','PENDING'); end if;
      -- Historical candidates establish no unpaid debt. No durable financial row
      -- is required merely because a deployment receives an old event.
      select a.id into activation_id from driver_compensation_activation a where a.effective_at<=delivery_row.delivered_at;
      if activation_id is null then return context_json||jsonb_build_object('state','HISTORICAL_REVIEW'); end if;
      select * into ship_row from pickup_operation where id=completion_row.ship_operation_id and deleted_at is null;
      select * into prepare_row from pickup_operation where delivery_id=target and action='PREPARE' and deleted_at is null;
      select * into event_row from dispatch_event where target_id=target and target_type='DELIVERY' and action='DELIVERED' order by revision limit 1;
      select pe.id into native_proof_id from dispatch_event pe where pe.target_id=target and pe.target_type='DELIVERY' and pe.action='NATIVE_DELIVERED_PROVEN'
        and pe.evidence->>'commitment_id'=commitment_row.id order by pe.revision limit 1;
      if delivery_row.delivered_at is null or delivery_row.arrived_at is null or delivery_row.picked_up_at is null
        or completion_row.id is null or completion_row.state is distinct from 'SUCCEEDED' or completion_row.native_done is distinct from true
        or completion_row.workflow_id is distinct from 'mark-order-fulfillment-as-delivered-workflow'
        or jsonb_typeof(completion_row.receipt->'delivered_at') is distinct from 'string' or coalesce(completion_row.receipt->>'delivered_at','')=''
        or not (completion_row.receipt->>'delivered_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T')
        or commitment_row.id is null or commitment_row.status is distinct from 'COMPLETED' or commitment_row.delivery_id is distinct from target
        or commitment_row.assigned_at is null or ship_row.id is null or ship_row.delivery_id is distinct from target
        or ship_row.action is distinct from 'SHIP' or ship_row.state is distinct from 'SUCCEEDED' or ship_row.terminal_receipt is null
        or ship_row.native_state is distinct from 'done' or ship_row.terminal_receipt->>'fulfillment_id' is distinct from ship_row.fulfillment_id
        or prepare_row.id is null or prepare_row.state is distinct from 'SUCCEEDED' or prepare_row.fulfillment_id is distinct from ship_row.fulfillment_id
        or prepare_row.terminal_receipt->>'fulfillment_id' is distinct from ship_row.fulfillment_id
        or ship_row.fulfillment_id is null or ship_row.fulfillment_id is distinct from delivery_row.native_fulfillment_id
        or completion_row.receipt->>'fulfillment_id' is distinct from ship_row.fulfillment_id
        or ship_row.input->>'fulfillment_id' is distinct from ship_row.fulfillment_id
        or ship_row.input->>'order_id' is distinct from delivery_row.medusa_order_id
        or ship_row.input->>'commitment_id' is distinct from commitment_row.id
        or ship_row.input->>'driver_profile_id' is distinct from commitment_row.driver_profile_id
        or ship_row.input->'items' is distinct from prepare_row.input->'items'
        or not exists(select 1 from pick_session ps where ps.id=delivery_row.pick_session_id and ps.status='COMPLETED' and ps.source_lines_fingerprint=ship_row.input->>'picking_fingerprint')
        or not exists(select 1 from order_operation oo where oo.id=delivery_row.order_operation_id and oo.medusa_order_id=delivery_row.medusa_order_id
          and oo.merchant_id=delivery_row.merchant_id and oo.merchant_store_id=delivery_row.merchant_store_id)
        or not exists(select 1 from handoff_generation hg where hg.id=completion_row.generation_id and hg.delivery_id=target and hg.state='CONSUMED')
        or event_row.id is null or native_proof_id is null or event_row.evidence->>'commitment_id' is distinct from commitment_row.id
        then return context_json||jsonb_build_object('state','UNRESOLVED','reason','COMPLETION_EVIDENCE_MISMATCH'); end if;
      begin
        perform (completion_row.receipt->>'delivered_at')::timestamptz;
      exception when invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then
        return context_json||jsonb_build_object('state','UNRESOLVED','reason','COMPLETION_EVIDENCE_MISMATCH');
      end;
      if delivery_row.restricted_content_present then
        select rc.id into recipient_id from recipient_compliance rc where rc.delivery_id=target and rc.commitment_id=commitment_row.id
          and rc.driver_profile_id=commitment_row.driver_profile_id and rc.generation_id=completion_row.generation_id and rc.outcome='SATISFIED' and rc.deleted_at is null;
        if recipient_id is null then return context_json||jsonb_build_object('state','UNRESOLVED','reason','COMPLETION_EVIDENCE_MISMATCH'); end if;
      end if;
      if not exists(select 1 from driver_compensation_activation a where a.id=activation_id and a.effective_at<=commitment_row.assigned_at)
        then return context_json||jsonb_build_object('state','HISTORICAL_REVIEW'); end if;
      select * into snapshot_row from driver_compensation_snapshot where commitment_id=commitment_row.id;
      if snapshot_row.id is null then return context_json||jsonb_build_object('state','UNRESOLVED','reason','SNAPSHOT_MISSING'); end if;
      if (snapshot_row.delivery_id,snapshot_row.driver_profile_id,snapshot_row.merchant_id,snapshot_row.store_id,snapshot_row.affiliation_id,snapshot_row.affiliation_revision,snapshot_row.assigned_at)
        is distinct from (target,commitment_row.driver_profile_id,delivery_row.merchant_id,delivery_row.merchant_store_id,commitment_row.affiliation_id,commitment_row.affiliation_revision,commitment_row.assigned_at)
        or snapshot_row.activation_id is distinct from activation_id
        then return context_json||jsonb_build_object('state','UNRESOLVED','reason','SNAPSHOT_IDENTITY_MISMATCH'); end if;
      if snapshot_row.path is distinct from commitment_row.path or snapshot_row.currency is distinct from 'zar' or snapshot_row.policy_version is distinct from 'M21_B_V1'
        or not coalesce((snapshot_row.state='RESOLVED_GOSPAZA_PAYABLE' and snapshot_row.path='PLATFORM' and snapshot_row.payer='GOSPAZA' and snapshot_row.amount_minor>0 and snapshot_row.terms_id is not null)
          or (snapshot_row.state='RESOLVED_NON_GOSPAZA_PAYABLE' and snapshot_row.path='MERCHANT' and snapshot_row.payer='NON_GOSPAZA_PAYABLE' and snapshot_row.amount_minor is null and snapshot_row.terms_id is null),false)
        then return context_json||jsonb_build_object('state','UNRESOLVED','reason','PAYER_CLASSIFICATION_CONFLICT'); end if;
      fingerprint:=md5(jsonb_build_array(target,delivery_row.medusa_order_id,delivery_row.merchant_id,delivery_row.merchant_store_id,
        commitment_row.id,commitment_row.driver_profile_id,completion_row.id,completion_row.generation_id,completion_row.receipt,
        ship_row.id,ship_row.input_fingerprint,ship_row.terminal_receipt,prepare_row.id,event_row.id,event_row.revision,native_proof_id,
        extract(epoch from delivery_row.delivered_at)::text,snapshot_row.id,snapshot_row.source_fingerprint,
        snapshot_row.state,snapshot_row.path,snapshot_row.payer,snapshot_row.currency,snapshot_row.amount_minor,snapshot_row.terms_id,snapshot_row.terms_revision,recipient_id)::text);
      return context_json||jsonb_build_object('state','READY','source_fingerprint',fingerprint,'event_id',event_row.id,'source_revision',event_row.revision,
        'snapshot',jsonb_build_object('id',snapshot_row.id,'state',snapshot_row.state,'path',snapshot_row.path,'payer',snapshot_row.payer,
          'currency',snapshot_row.currency,'amount_minor',snapshot_row.amount_minor::text));
    end;
    $m21c$ language plpgsql`,
  `create function gospaza_driver_earning_immutable() returns trigger as $m21c$
    begin raise exception 'Immutable driver earning history' using errcode='23514'; end;
    $m21c$ language plpgsql`,
  ...["driver_earning_recognition", "driver_earning", "driver_earning_exception", "driver_earning_audit"].map(table =>
    `create trigger ${table}_immutable before update or delete on ${table} for each row execute function gospaza_driver_earning_immutable()`),
  `create function gospaza_driver_earning_recognition_guard() returns trigger as $m21c$
    declare source_json jsonb; expected_outcome text;
    begin
      source_json:=gospaza_driver_earning_source(NEW.delivery_id);
      expected_outcome:=case when source_json->'snapshot'->>'state'='RESOLVED_GOSPAZA_PAYABLE' then 'EARNED' else 'NON_GOSPAZA_PAYABLE' end;
      if source_json->>'state' is distinct from 'READY' or NEW.outcome<>expected_outcome
        or (NEW.completion_id,NEW.commitment_id,NEW.driver_profile_id,NEW.snapshot_id,NEW.source_fingerprint)
          is distinct from (source_json->>'completion_id',source_json->>'commitment_id',source_json->>'driver_profile_id',source_json->'snapshot'->>'id',source_json->>'source_fingerprint')
        then raise exception 'Unproven driver earning recognition' using errcode='23514'; end if;
      NEW.recorded_at:=clock_timestamp();return NEW;
    end;
    $m21c$ language plpgsql`,
  `create trigger driver_earning_recognition_source before insert on driver_earning_recognition for each row execute function gospaza_driver_earning_recognition_guard()`,
  `create function gospaza_driver_earning_guard() returns trigger as $m21c$
    declare source_json jsonb;
    begin
      source_json:=gospaza_driver_earning_source(NEW.delivery_id);
      if source_json->>'state' is distinct from 'READY' or source_json->'snapshot'->>'state' is distinct from 'RESOLVED_GOSPAZA_PAYABLE'
        or not exists(select 1 from driver_earning_recognition rr join driver_compensation_snapshot ss on ss.id=rr.snapshot_id
          join delivery_operation dd on dd.id=rr.delivery_id where rr.id=NEW.recognition_id and rr.outcome='EARNED'
          and (rr.delivery_id,rr.completion_id,rr.commitment_id,rr.driver_profile_id,rr.snapshot_id,rr.source_fingerprint)
            =(NEW.delivery_id,NEW.completion_id,NEW.commitment_id,NEW.driver_profile_id,NEW.snapshot_id,NEW.source_fingerprint)
          and (NEW.amount_minor,NEW.currency,NEW.payer,NEW.payer_classification,NEW.terms_id,NEW.terms_revision,NEW.terms_policy_version)
            =(ss.amount_minor,ss.currency,ss.payer,ss.path,ss.terms_id,ss.terms_revision,ss.policy_version)
          and (NEW.order_id,NEW.merchant_id,NEW.store_id,NEW.economic_at)=(dd.medusa_order_id,dd.merchant_id,dd.merchant_store_id,dd.delivered_at))
        or (NEW.source_fingerprint,NEW.event_id,NEW.source_revision) is distinct from (source_json->>'source_fingerprint',source_json->>'event_id',(source_json->>'source_revision')::integer)
        then raise exception 'Unproven driver earning' using errcode='23514'; end if;
      NEW.recorded_at:=clock_timestamp();return NEW;
    end;
    $m21c$ language plpgsql`,
  `create trigger driver_earning_source before insert on driver_earning for each row execute function gospaza_driver_earning_guard()`,
  `create function gospaza_driver_earning_exception_guard() returns trigger as $m21c$
    declare source_json jsonb; original_fingerprint text;
    begin
      source_json:=gospaza_driver_earning_source(NEW.delivery_id);
      select rr.source_fingerprint into original_fingerprint from driver_earning_recognition rr where rr.delivery_id=NEW.delivery_id;
      if NEW.reason='SOURCE_CONFLICT' then
        if original_fingerprint is null or (source_json->>'state'='READY' and original_fingerprint=source_json->>'source_fingerprint')
          then raise exception 'Unproven driver earning conflict' using errcode='23514'; end if;
      elsif source_json->>'state' is distinct from 'UNRESOLVED' or NEW.reason is distinct from source_json->>'reason'
        then raise exception 'Unproven driver earning exception' using errcode='23514'; end if;
      NEW.commitment_id:=source_json->>'commitment_id';NEW.completion_id:=source_json->>'completion_id';NEW.driver_profile_id:=source_json->>'driver_profile_id';
      NEW.source_id:=coalesce(NEW.completion_id,NEW.commitment_id,NEW.delivery_id);NEW.recorded_at:=clock_timestamp();
      NEW.first_evidence:=jsonb_build_object('source_state',source_json->>'state','observed_reason',source_json->>'reason','observed_fingerprint',source_json->>'source_fingerprint',
        'original_fingerprint',original_fingerprint,'snapshot_id',source_json->'snapshot'->>'id');return NEW;
    end;
    $m21c$ language plpgsql`,
  `create trigger driver_earning_exception_source before insert on driver_earning_exception for each row execute function gospaza_driver_earning_exception_guard()`,
  `create function gospaza_driver_earning_consistency() returns trigger as $m21c$
    declare audit_kind text; fingerprint text;
    begin
      if TG_TABLE_NAME='driver_earning_recognition' then
        audit_kind:='RECOGNITION';fingerprint:=NEW.source_fingerprint;
        if (NEW.outcome='EARNED') is distinct from (exists(select 1 from driver_earning ee where ee.recognition_id=NEW.id))
          then raise exception 'Driver earning recognition requires matching earning' using errcode='23514'; end if;
      elsif TG_TABLE_NAME='driver_earning' then audit_kind:='EARNING';fingerprint:=NEW.source_fingerprint;
      else audit_kind:='EXCEPTION';fingerprint:=NEW.reason; end if;
      if not exists(select 1 from driver_earning_audit aa where aa.kind=audit_kind and aa.target_id=NEW.id and aa.source_fingerprint=fingerprint)
        then raise exception 'Driver earning audit required' using errcode='23514'; end if;
      return null;
    end;
    $m21c$ language plpgsql`,
  ...["driver_earning_recognition", "driver_earning", "driver_earning_exception"].map(table =>
    `create constraint trigger ${table}_consistency after insert on ${table} deferrable initially deferred for each row execute function gospaza_driver_earning_consistency()`),
];
