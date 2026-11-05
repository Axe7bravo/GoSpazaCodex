// SQL-owned Finance extension. Each entry is one top-level statement; function
// bodies remain intact for MikroORM's transactional migration execution.
export const driverCompensationSql = [
  `create table driver_compensation_terms (
    id text primary key, scope text not null check(scope='PLATFORM_FLAT'), payer text not null check(payer='GOSPAZA'),
    affiliation_kind text not null check(affiliation_kind='PLATFORM'), currency text not null check(currency='zar'),
    amount_minor bigint not null check(amount_minor between 1 and 9007199254740991),
    revision integer not null unique check(revision>0), effective_at timestamptz not null unique, recorded_at timestamptz not null,
    actor_id text not null, reason text not null check(length(reason) between 1 and 240), request_id text not null unique,
    request_fingerprint text not null, policy_version text not null check(policy_version='M21_B_V1'), check(effective_at>=recorded_at))`,
  `create table driver_compensation_activation (
    id text primary key, singleton boolean not null default true unique check(singleton), revision integer not null check(revision=1),
    effective_at timestamptz not null, recorded_at timestamptz not null, actor_id text not null,
    reason text not null check(length(reason) between 1 and 240), request_id text not null unique, request_fingerprint text not null,
    policy_version text not null check(policy_version='M21_B_V1'), check(effective_at>=recorded_at))`,
  `create table driver_compensation_audit (
    id text primary key, kind text not null check(kind in ('TERMS','ACTIVATION','SNAPSHOT','EXCEPTION')),
    target_id text not null, actor_id text, recorded_at timestamptz not null default clock_timestamp(),
    fingerprint text not null, unique(kind,target_id))`,
  `create table driver_compensation_snapshot (
    id text primary key, commitment_id text not null unique references dispatch_commitment(id),
    delivery_id text not null references delivery_operation(id), driver_profile_id text not null references driver_profile(id),
    merchant_id text not null references merchant(id), store_id text not null references merchant_store(id),
    affiliation_id text not null references driver_affiliation(id), affiliation_revision integer not null,
    path text not null check(path in ('MERCHANT','PLATFORM')), payer text not null check(payer in ('GOSPAZA','NON_GOSPAZA_PAYABLE')),
    currency text not null check(currency='zar'), amount_minor bigint, terms_id text references driver_compensation_terms(id),
    terms_revision integer, effective_at timestamptz, activation_id text not null references driver_compensation_activation(id),
    assigned_at timestamptz not null, snapshot_at timestamptz not null, policy_version text not null check(policy_version='M21_B_V1'),
    state text not null check(state in ('RESOLVED_GOSPAZA_PAYABLE','RESOLVED_NON_GOSPAZA_PAYABLE')),
    source_fingerprint text not null,
    check((state='RESOLVED_GOSPAZA_PAYABLE' and path='PLATFORM' and payer='GOSPAZA' and amount_minor is not null and amount_minor>0 and terms_id is not null and terms_revision is not null and effective_at is not null)
      or (state='RESOLVED_NON_GOSPAZA_PAYABLE' and path='MERCHANT' and payer='NON_GOSPAZA_PAYABLE' and amount_minor is null and terms_id is null and terms_revision is null and effective_at is null)))`,
  `create table driver_compensation_exception (
    id text primary key, commitment_id text not null references dispatch_commitment(id), delivery_id text not null references delivery_operation(id),
    driver_profile_id text not null references driver_profile(id), activation_id text references driver_compensation_activation(id),
    reason text not null check(reason in ('MISSING_COMPENSATION_TERMS','HISTORICAL_PREACTIVATION','SNAPSHOT_MISSING','SNAPSHOT_CONFLICT')),
    recorded_at timestamptz not null default clock_timestamp(), unique(commitment_id,reason))`,
  `create index driver_compensation_exception_page on driver_compensation_exception(commitment_id,id)`,
  `create function gospaza_driver_comp_immutable() returns trigger as $m21$
    begin raise exception 'Immutable driver compensation history' using errcode='23514'; end;
    $m21$ language plpgsql`,
  ...["driver_compensation_terms", "driver_compensation_activation", "driver_compensation_audit", "driver_compensation_snapshot", "driver_compensation_exception"].map(table =>
    `create trigger ${table}_immutable before update or delete on ${table} for each row execute function gospaza_driver_comp_immutable()`),
  `create function gospaza_driver_comp_publish() returns trigger as $m21$
    declare publication_time timestamptz;
    begin
      perform pg_advisory_xact_lock(21021001::bigint);
      publication_time:=clock_timestamp();
      if NEW.recorded_at is not null then raise exception 'Server compensation time required' using errcode='23514'; end if;
      NEW.recorded_at:=publication_time;
      if NEW.effective_at is null then NEW.effective_at:=publication_time; end if;
      if NEW.effective_at<publication_time then raise exception 'Retroactive compensation decision' using errcode='23514',constraint='driver_compensation_no_backdating'; end if;
      if TG_TABLE_NAME='driver_compensation_terms' and NEW.revision<>coalesce((select max(t.revision) from driver_compensation_terms t),0)+1
        then raise exception 'Compensation revision conflict' using errcode='23514',constraint='driver_compensation_revision'; end if;
      return NEW;
    end;
    $m21$ language plpgsql`,
  `create trigger driver_compensation_terms_publish before insert on driver_compensation_terms for each row execute function gospaza_driver_comp_publish()`,
  `create trigger driver_compensation_activation_publish before insert on driver_compensation_activation for each row execute function gospaza_driver_comp_publish()`,
  // Publication never acquires merchant/profile/operational locks. Assignment
  // takes this shared lock only after its existing operational prefix.
  `create function gospaza_driver_comp_selection(at_time timestamptz) returns table(activation_id text,terms_id text) as $m21$
    begin
      perform pg_advisory_xact_lock_shared(21021001::bigint);
      return query select a.id,(select t.id from driver_compensation_terms t where t.effective_at<=at_time order by t.effective_at desc,t.revision desc limit 1)
        from driver_compensation_activation a where a.effective_at<=at_time;
    end;
    $m21$ language plpgsql`,
  `create function gospaza_driver_comp_snapshot_guard() returns trigger as $m21$
    declare commitment_row dispatch_commitment; delivery_row delivery_operation; selected record; terms_row driver_compensation_terms;
    begin
      select * into commitment_row from dispatch_commitment where id=NEW.commitment_id;
      select * into delivery_row from delivery_operation where id=commitment_row.delivery_id;
      if commitment_row.status<>'ASSIGNED' or commitment_row.assigned_at is null or
        (NEW.delivery_id,NEW.driver_profile_id,NEW.affiliation_id,NEW.affiliation_revision,NEW.path,NEW.assigned_at,NEW.merchant_id,NEW.store_id)
        is distinct from (commitment_row.delivery_id,commitment_row.driver_profile_id,commitment_row.affiliation_id,commitment_row.affiliation_revision,commitment_row.path,commitment_row.assigned_at,delivery_row.merchant_id,delivery_row.merchant_store_id)
        then raise exception 'Compensation assignment binding' using errcode='23514'; end if;
      select * into selected from gospaza_driver_comp_selection(commitment_row.assigned_at);
      if selected.activation_id is null or NEW.activation_id is distinct from selected.activation_id then raise exception 'Compensation activation binding' using errcode='23514'; end if;
      if NEW.path='PLATFORM' then
        select * into terms_row from driver_compensation_terms where id=selected.terms_id;
        if terms_row.id is null or (NEW.terms_id,NEW.terms_revision,NEW.amount_minor,NEW.effective_at) is distinct from (terms_row.id,terms_row.revision,terms_row.amount_minor,terms_row.effective_at)
          then raise exception 'Compensation terms binding' using errcode='23514'; end if;
      end if;
      if NEW.snapshot_at is not null then raise exception 'Server snapshot time required' using errcode='23514'; end if;
      NEW.snapshot_at:=clock_timestamp();
      NEW.source_fingerprint:=md5(jsonb_build_array(NEW.commitment_id,NEW.delivery_id,NEW.driver_profile_id,NEW.merchant_id,NEW.store_id,NEW.affiliation_id,NEW.affiliation_revision,NEW.path,NEW.payer,NEW.currency,NEW.assigned_at,NEW.activation_id,NEW.terms_id,NEW.terms_revision,NEW.effective_at,NEW.amount_minor,NEW.state,NEW.policy_version)::text);
      return NEW;
    end;
    $m21$ language plpgsql`,
  `create trigger driver_compensation_snapshot_binding before insert on driver_compensation_snapshot for each row execute function gospaza_driver_comp_snapshot_guard()`,
  `create function gospaza_driver_comp_exception_guard() returns trigger as $m21$
    begin
      if not exists(select 1 from dispatch_commitment c where c.id=NEW.commitment_id and c.delivery_id=NEW.delivery_id and c.driver_profile_id=NEW.driver_profile_id)
        then raise exception 'Compensation exception binding' using errcode='23514'; end if;
      NEW.recorded_at:=clock_timestamp();
      return NEW;
    end;
    $m21$ language plpgsql`,
  `create trigger driver_compensation_exception_binding before insert on driver_compensation_exception for each row execute function gospaza_driver_comp_exception_guard()`,
  `create function gospaza_driver_comp_audit_check() returns trigger as $m21$
    declare audit_kind text; expected_actor text; expected_fingerprint text; expected_time timestamptz;
    begin
      if TG_TABLE_NAME='driver_compensation_terms' then audit_kind:='TERMS';expected_actor:=NEW.actor_id;expected_fingerprint:=NEW.request_fingerprint;expected_time:=NEW.recorded_at;
      elsif TG_TABLE_NAME='driver_compensation_activation' then audit_kind:='ACTIVATION';expected_actor:=NEW.actor_id;expected_fingerprint:=NEW.request_fingerprint;expected_time:=NEW.recorded_at;
      elsif TG_TABLE_NAME='driver_compensation_snapshot' then audit_kind:='SNAPSHOT';expected_actor:=null;expected_fingerprint:=NEW.source_fingerprint;
      else audit_kind:='EXCEPTION';expected_actor:=null;expected_fingerprint:=NEW.reason; end if;
      if not exists(select 1 from driver_compensation_audit a where a.kind=audit_kind and a.target_id=NEW.id and a.actor_id is not distinct from expected_actor and a.fingerprint=expected_fingerprint and (expected_time is null or a.recorded_at=expected_time))
        then raise exception 'Driver compensation audit required' using errcode='23514'; end if;
      return null;
    end;
    $m21$ language plpgsql`,
  ...["driver_compensation_terms", "driver_compensation_activation", "driver_compensation_snapshot", "driver_compensation_exception"].map(table =>
    `create constraint trigger ${table}_audit after insert on ${table} deferrable initially deferred for each row execute function gospaza_driver_comp_audit_check()`),
];

// Separate so private-schema verification can use the installed operational
// trigger without adding a second trigger to the public dispatch table.
export const driverCompensationAssignmentSql = [
  `create function gospaza_driver_comp_assignment_check() returns trigger as $m21$
    declare selected record;
    begin
      if NEW.status='ASSIGNED' and OLD.status='OFFERED' then
        select * into selected from gospaza_driver_comp_selection(NEW.assigned_at);
        if selected.activation_id is not null and not exists(select 1 from driver_compensation_snapshot s where s.commitment_id=NEW.id)
          then raise exception 'Assigned commitment requires compensation snapshot' using errcode='23514'; end if;
      end if;
      return null;
    end;
    $m21$ language plpgsql`,
  `create constraint trigger dispatch_compensation_consistency after update on dispatch_commitment deferrable initially deferred for each row execute function gospaza_driver_comp_assignment_check()`,
];
