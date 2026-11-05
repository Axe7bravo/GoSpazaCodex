// SQL-owned records; no generated module CRUD. Each entry is one top-level statement.
export const merchantSettlementSql: readonly string[] = [
  `create table settlement_period_policy(id text primary key,version text not null check(version='M20_B_V1'),timezone text not null check(timezone='Africa/Johannesburg'),currency text not null check(currency='zar'),activation_at timestamptz not null,recorded_at timestamptz not null default clock_timestamp(),actor_id text not null,reason text not null check(length(reason) between 1 and 240),tax_policy text not null check(tax_policy='TAX_HELD'),shipping_policy text not null check(shipping_policy='EXCLUDED'))`,
  `create unique index settlement_single_initial_policy on settlement_period_policy(version)`,
  `create table merchant_period_statement(id text primary key,merchant_id text not null references merchant(id),store_id text not null references merchant_store(id),currency text not null check(currency='zar'),policy_id text not null references settlement_period_policy(id),policy_version text not null,period_start timestamptz not null,period_end timestamptz not null,cutoff timestamptz not null,version integer not null check(version>0),revision integer not null default 1 check(revision>0),status text not null default 'DRAFT' check(status in ('DRAFT','READY_FOR_APPROVAL')),superseded_by text references merchant_period_statement(id) deferrable initially deferred,superseded_at timestamptz,superseded_actor text,superseded_reason text,finalized_at timestamptz,generated_at timestamptz not null default clock_timestamp(),actor_id text not null,manifest_fingerprint text not null,included_count integer not null check(included_count>=0),excluded_count integer not null check(excluded_count>=0),merchandise_minor bigint not null,tax_held_minor bigint not null,subsidy_minor bigint not null,commission_minor bigint not null,current_effects_minor bigint not null,incoming_carry_minor bigint not null check(incoming_carry_minor<=0),net_minor bigint not null,payable_minor bigint not null check(payable_minor>=0),outgoing_carry_minor bigint not null check(outgoing_carry_minor<=0),check(cutoff=period_end and period_end>period_start),check(net_minor=current_effects_minor+incoming_carry_minor),check(payable_minor=greatest(net_minor,0)),check(outgoing_carry_minor=least(net_minor,0)),check((superseded_by is null and superseded_at is null and superseded_actor is null and superseded_reason is null) or (superseded_by is not null and superseded_at is not null and superseded_actor is not null and length(superseded_reason) between 1 and 240)),unique(merchant_id,store_id,currency,period_start,version))`,
  `create unique index settlement_current_period on merchant_period_statement(merchant_id,store_id,currency,period_start) where superseded_by is null`,
  `create table settlement_item(statement_id text not null references merchant_period_statement(id),posting_id text not null references marketplace_finance_posting(id),snapshot_id text not null references order_finance_snapshot(id),order_id text not null,economic_at timestamptz not null,recorded_at timestamptz not null,prior_period boolean not null,merchandise_minor bigint not null,tax_held_minor bigint not null,subsidy_minor bigint not null,commission_minor bigint not null,entitlement_minor bigint not null,primary key(statement_id,posting_id))`,
  `create table settlement_exclusion(statement_id text not null references merchant_period_statement(id),snapshot_id text not null references order_finance_snapshot(id),posting_id text references marketplace_finance_posting(id),order_id text not null,reason text not null check(reason in ('HISTORICAL_CATCH_UP','UNRESOLVED_FINANCE')),held_minor bigint,primary key(statement_id,snapshot_id))`,
  `create table settlement_source_claim(posting_id text primary key references marketplace_finance_posting(id),statement_id text references merchant_period_statement(id))`,
  `create table settlement_carry_effect(statement_id text primary key references merchant_period_statement(id),amount_minor bigint not null check(amount_minor<0))`,
  `create table settlement_carry_claim(source_statement_id text primary key references settlement_carry_effect(statement_id),statement_id text references merchant_period_statement(id))`,
  `create table payable_settlement(id text primary key,statement_id text not null unique references merchant_period_statement(id),amount_minor bigint not null check(amount_minor>0),currency text not null check(currency='zar'),status text not null check(status in ('DRAFT','READY_FOR_APPROVAL')))`,
  `create table settlement_transition_audit(id text primary key,statement_id text not null references merchant_period_statement(id),actor_id text not null,action text not null check(action in ('GENERATED','SUPERSEDED','READY','FINALIZED')),request_id text not null unique,request_fingerprint text not null,reason text not null,revision integer not null,recorded_at timestamptz not null default clock_timestamp())`,
  `create table settlement_claim_history(id bigint generated always as identity primary key,kind text not null,source_id text not null,previous_statement_id text,new_statement_id text,recorded_at timestamptz not null default clock_timestamp())`,
  `create function gospaza_settlement_period(activation timestamptz, requested timestamptz) returns table(first_start timestamptz,start_at timestamptz,end_at timestamptz) as $m20$ declare local_first timestamp; local_start timestamp; begin local_first:=date_trunc('week',activation at time zone 'Africa/Johannesburg'); if local_first at time zone 'Africa/Johannesburg'<activation then local_first:=local_first+interval '1 week'; end if; local_start:=date_trunc('week',requested at time zone 'Africa/Johannesburg'); first_start:=local_first at time zone 'Africa/Johannesburg'; start_at:=local_start at time zone 'Africa/Johannesburg'; end_at:=(local_start+interval '1 week') at time zone 'Africa/Johannesburg'; return next; end; $m20$ language plpgsql immutable`,
  `create function gospaza_settlement_immutable() returns trigger as $m20$ begin raise exception 'Immutable M20 settlement evidence' using errcode='23514'; end; $m20$ language plpgsql`,
  `create trigger settlement_period_policy_immutable before update or delete on settlement_period_policy for each row execute function gospaza_settlement_immutable()`,
  `create trigger settlement_item_immutable before update or delete on settlement_item for each row execute function gospaza_settlement_immutable()`,
  `create trigger settlement_exclusion_immutable before update or delete on settlement_exclusion for each row execute function gospaza_settlement_immutable()`,
  `create trigger settlement_carry_effect_immutable before update or delete on settlement_carry_effect for each row execute function gospaza_settlement_immutable()`,
  `create trigger settlement_transition_audit_immutable before update or delete on settlement_transition_audit for each row execute function gospaza_settlement_immutable()`,
  `create trigger settlement_claim_history_immutable before update or delete on settlement_claim_history for each row execute function gospaza_settlement_immutable()`,
  `create function gospaza_settlement_manifest(target text) returns text as $m20$ select md5(jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i) order by i.posting_id) from settlement_item i where i.statement_id=target),'[]'::jsonb),'holds',coalesce((select jsonb_agg(to_jsonb(h) order by h.snapshot_id) from settlement_exclusion h where h.statement_id=target),'[]'::jsonb))::text) $m20$ language sql stable set timezone='UTC'`,
  `create function gospaza_settlement_statement_guard() returns trigger as $m20$
declare policy_row settlement_period_policy; calendar record;
begin
 if TG_OP='DELETE' then raise exception 'Immutable M20 statement' using errcode='23514'; end if;
 if TG_OP='INSERT' then
  perform 1 from merchant where id=NEW.merchant_id for update;
  select * into strict policy_row from settlement_period_policy where id=NEW.policy_id;
  select * into calendar from gospaza_settlement_period(policy_row.activation_at,NEW.period_start);
  if NEW.policy_version<>policy_row.version or NEW.period_start<>calendar.start_at or NEW.period_start<calendar.first_start or NEW.period_end<>calendar.end_at or NEW.cutoff>=clock_timestamp()
   or not exists(select 1 from merchant_store where id=NEW.store_id and merchant_id=NEW.merchant_id and deleted_at is null)
   or exists(select 1 from merchant_period_statement x where x.merchant_id=NEW.merchant_id and x.store_id=NEW.store_id and x.currency=NEW.currency and x.period_start>NEW.period_start)
   or (NEW.period_start>calendar.first_start and not exists(select 1 from merchant_period_statement x where x.merchant_id=NEW.merchant_id and x.store_id=NEW.store_id and x.currency=NEW.currency and x.period_end=NEW.period_start and x.superseded_by is null and (x.status='READY_FOR_APPROVAL' or x.finalized_at is not null)))
  then raise exception 'Settlement period or tenant conflict' using errcode='23514'; end if;
  if NEW.status<>'DRAFT' or NEW.revision<>1 or NEW.finalized_at is not null then raise exception 'Settlement initial state' using errcode='23514'; end if;
  return NEW;
 end if;
 if (to_jsonb(NEW)-array['status','revision','superseded_by','superseded_at','superseded_actor','superseded_reason','finalized_at','manifest_fingerprint'])<>(to_jsonb(OLD)-array['status','revision','superseded_by','superseded_at','superseded_actor','superseded_reason','finalized_at','manifest_fingerprint']) then raise exception 'Immutable M20 statement economics' using errcode='23514'; end if;
 if OLD.manifest_fingerprint='PENDING' and NEW.manifest_fingerprint=gospaza_settlement_manifest(OLD.id) and (to_jsonb(NEW)-'manifest_fingerprint')=(to_jsonb(OLD)-'manifest_fingerprint') then return NEW; end if;
 if OLD.status<>'DRAFT' or OLD.finalized_at is not null or OLD.superseded_by is not null or NEW.manifest_fingerprint<>OLD.manifest_fingerprint or NEW.revision<>OLD.revision+1 then raise exception 'Settlement state/revision conflict' using errcode='23514'; end if;
 if not ((NEW.status='READY_FOR_APPROVAL' and NEW.payable_minor>0 and NEW.finalized_at is null and NEW.superseded_by is null)
 or (NEW.status='DRAFT' and NEW.payable_minor=0 and NEW.finalized_at is not null and NEW.superseded_by is null)
 or (NEW.status='DRAFT' and NEW.finalized_at is null and NEW.superseded_by is not null)) then raise exception 'Settlement transition denied' using errcode='23514'; end if;
 return NEW;
end; $m20$ language plpgsql`,
  `create trigger settlement_statement_guard before insert or update or delete on merchant_period_statement for each row execute function gospaza_settlement_statement_guard()`,
  `create function gospaza_settlement_claim_guard() returns trigger as $m20$
declare previous_id text; next_id text; source_identity text; source_key text;
begin
 if TG_OP='DELETE' then raise exception 'Settlement claims cannot be deleted' using errcode='23514'; end if;
 source_key:=TG_ARGV[0]; source_identity:=to_jsonb(NEW)->>source_key; next_id:=NEW.statement_id;
 if TG_OP='INSERT' and next_id is null then raise exception 'Settlement initial claim owner required' using errcode='23514'; end if;
 if TG_OP='UPDATE' then
  previous_id:=OLD.statement_id;
  if source_identity is distinct from to_jsonb(OLD)->>source_key or (previous_id is null and not exists(select 1 from settlement_claim_history h join merchant_period_statement previous on previous.id=h.previous_statement_id where h.kind=TG_TABLE_NAME and h.source_id=source_identity and h.new_statement_id is null and previous.superseded_by is not null)) or (previous_id is not null and not exists(select 1 from merchant_period_statement s where s.id=previous_id and s.status='DRAFT' and s.superseded_by is not null and s.finalized_at is null and (next_id is null or s.superseded_by=next_id))) then raise exception 'Settlement claim transfer denied' using errcode='23514'; end if;
 end if;
 if next_id is not null and not exists(select 1 from merchant_period_statement s where s.id=next_id and s.status='DRAFT' and s.superseded_by is null and s.finalized_at is null) then raise exception 'Settlement claim owner unavailable' using errcode='23514'; end if;
 insert into settlement_claim_history(kind,source_id,previous_statement_id,new_statement_id) values(TG_TABLE_NAME,source_identity,previous_id,next_id);
 return NEW;
end; $m20$ language plpgsql`,
  `create trigger settlement_source_claim_guard before insert or update or delete on settlement_source_claim for each row execute function gospaza_settlement_claim_guard('posting_id')`,
  `create trigger settlement_carry_claim_guard before insert or update or delete on settlement_carry_claim for each row execute function gospaza_settlement_claim_guard('source_statement_id')`,
  `create function gospaza_settlement_payable_guard() returns trigger as $m20$ begin
 if TG_OP='DELETE' then raise exception 'Immutable payable settlement' using errcode='23514'; end if;
 if TG_OP='UPDATE' and ((to_jsonb(NEW)-'status')<>(to_jsonb(OLD)-'status') or OLD.status<>'DRAFT' or NEW.status<>'READY_FOR_APPROVAL') then raise exception 'Payable transition denied' using errcode='23514'; end if;
 if not exists(select 1 from merchant_period_statement s where s.id=NEW.statement_id and s.payable_minor=NEW.amount_minor and s.currency=NEW.currency and s.status=NEW.status and s.superseded_by is null) then raise exception 'Payable statement mismatch' using errcode='23514'; end if;
 return NEW; end; $m20$ language plpgsql`,
  `create trigger settlement_payable_guard before insert or update or delete on payable_settlement for each row execute function gospaza_settlement_payable_guard()`,
  `create function gospaza_settlement_consistent(target text) returns void as $m20$
declare statement_row merchant_period_statement; sums record; incoming bigint; actual_count integer;
begin
 select * into statement_row from merchant_period_statement where id=target;
 if not found then raise exception 'Settlement missing' using errcode='23514'; end if;
 select count(*) as count,coalesce(sum(i.merchandise_minor),0) as merchandise,coalesce(sum(i.tax_held_minor),0) as tax,coalesce(sum(i.subsidy_minor),0) as subsidy,coalesce(sum(i.commission_minor),0) as commission,coalesce(sum(i.entitlement_minor),0) as entitlement into sums from settlement_item i where i.statement_id=target;
 select count(*) into actual_count from settlement_exclusion where statement_id=target;
 if (sums.count,sums.merchandise,sums.tax,sums.subsidy,sums.commission,sums.entitlement,actual_count) is distinct from (statement_row.included_count::bigint,statement_row.merchandise_minor::numeric,statement_row.tax_held_minor::numeric,statement_row.subsidy_minor::numeric,statement_row.commission_minor::numeric,statement_row.current_effects_minor::numeric,statement_row.excluded_count) or statement_row.manifest_fingerprint<>gospaza_settlement_manifest(target) then raise exception 'Settlement manifest/totals mismatch' using errcode='23514'; end if;
 if exists(select 1 from settlement_item i join marketplace_finance_posting p on p.id=i.posting_id join order_finance_snapshot s on s.id=p.snapshot_id join settlement_period_policy policy on policy.id=statement_row.policy_id where i.statement_id=target and ((i.snapshot_id,i.order_id,i.economic_at,i.recorded_at,i.merchandise_minor,i.tax_held_minor,i.subsidy_minor,i.commission_minor,i.entitlement_minor) is distinct from (p.snapshot_id,s.order_id,p.economic_at,p.recorded_at,p.merchandise_minor,p.tax_minor,p.subsidy_minor,p.commission_minor,p.entitlement_minor) or (s.merchant_id,s.store_id,s.currency) is distinct from (statement_row.merchant_id,statement_row.store_id,statement_row.currency) or s.state<>'RESOLVED' or p.economic_at<policy.activation_at or p.economic_at>=statement_row.period_end or p.recorded_at>statement_row.cutoff or i.prior_period<>(p.economic_at<statement_row.period_start))) then raise exception 'Settlement source mismatch' using errcode='23514'; end if;
 if not exists(select 1 from settlement_transition_audit a where a.statement_id=target and a.action='GENERATED' and a.revision=1) then raise exception 'Settlement audit missing' using errcode='23514'; end if;
 if statement_row.superseded_by is not null then
  if not exists(select 1 from merchant_period_statement replacement where replacement.id=statement_row.superseded_by and (replacement.merchant_id,replacement.store_id,replacement.currency,replacement.policy_id,replacement.period_start,replacement.version)=(statement_row.merchant_id,statement_row.store_id,statement_row.currency,statement_row.policy_id,statement_row.period_start,statement_row.version+1)) or not exists(select 1 from settlement_transition_audit a where a.statement_id=target and a.action='SUPERSEDED' and a.revision=statement_row.revision) or exists(select 1 from settlement_source_claim where statement_id=target) or exists(select 1 from settlement_carry_claim where statement_id=target) then raise exception 'Supersession consistency' using errcode='23514'; end if;
  return;
 end if;
 if exists(select 1 from settlement_item i left join settlement_source_claim c on c.posting_id=i.posting_id and c.statement_id=target where i.statement_id=target and c.posting_id is null) or exists(select 1 from settlement_source_claim c left join settlement_item i on i.posting_id=c.posting_id and i.statement_id=target where c.statement_id=target and i.posting_id is null) then raise exception 'Settlement claim mismatch' using errcode='23514'; end if;
 select coalesce(sum(e.amount_minor),0) into incoming from settlement_carry_claim c join settlement_carry_effect e on e.statement_id=c.source_statement_id join merchant_period_statement previous on previous.id=e.statement_id where c.statement_id=target and previous.superseded_by is null and previous.period_end=statement_row.period_start and (previous.merchant_id,previous.store_id,previous.currency)=(statement_row.merchant_id,statement_row.store_id,statement_row.currency) and (previous.status='READY_FOR_APPROVAL' or previous.finalized_at is not null);
 if incoming<>statement_row.incoming_carry_minor or (select count(*) from settlement_carry_claim where statement_id=target)>1 or exists(select 1 from settlement_carry_claim c join settlement_carry_effect e on e.statement_id=c.source_statement_id where c.statement_id=target and e.amount_minor<>incoming)
 or exists(select 1 from merchant_period_statement previous join settlement_carry_effect e on e.statement_id=previous.id where previous.merchant_id=statement_row.merchant_id and previous.store_id=statement_row.store_id and previous.currency=statement_row.currency and previous.period_end=statement_row.period_start and previous.superseded_by is null and not exists(select 1 from settlement_carry_claim c where c.source_statement_id=e.statement_id and c.statement_id=target)) then raise exception 'Settlement carry mismatch' using errcode='23514'; end if;
 -- Keep CASE's THEN inside parentheses, separate from PL/pgSQL's IF terminator.
 if (select count(*) from settlement_carry_effect where statement_id=target)<>(case when statement_row.outgoing_carry_minor<0 then 1 else 0 end) or exists(select 1 from settlement_carry_effect where statement_id=target and amount_minor<>statement_row.outgoing_carry_minor) then raise exception 'Settlement outgoing carry mismatch' using errcode='23514'; end if;
 if (select count(*) from payable_settlement where statement_id=target)<>(case when statement_row.payable_minor>0 then 1 else 0 end) or exists(select 1 from payable_settlement where statement_id=target and (amount_minor,currency,status)<>(statement_row.payable_minor,statement_row.currency,statement_row.status)) then raise exception 'Settlement payable mismatch' using errcode='23514'; end if;
 if statement_row.status='READY_FOR_APPROVAL' or statement_row.finalized_at is not null then
  if exists(select 1 from settlement_item i join order_finance_exception x on x.snapshot_id=i.snapshot_id where i.statement_id=target) or not exists(select 1 from settlement_transition_audit a where a.statement_id=target and a.revision=statement_row.revision and a.action=case when statement_row.payable_minor>0 then 'READY' else 'FINALIZED' end) then raise exception 'Settlement preparation consistency' using errcode='23514'; end if;
 end if;
end; $m20$ language plpgsql`,
  `create function gospaza_settlement_deferred() returns trigger as $m20$ declare target text; previous_target text; begin target:=to_jsonb(NEW)->>TG_ARGV[0]; if target is not null then perform gospaza_settlement_consistent(target); end if; if TG_OP='UPDATE' then previous_target:=to_jsonb(OLD)->>TG_ARGV[0]; if previous_target is not null and previous_target is distinct from target then perform gospaza_settlement_consistent(previous_target); end if; end if; return NEW; end; $m20$ language plpgsql`,
  `create constraint trigger merchant_period_statement_consistency after insert or update on merchant_period_statement deferrable initially deferred for each row execute function gospaza_settlement_deferred('id')`,
  `create constraint trigger settlement_item_consistency after insert or update on settlement_item deferrable initially deferred for each row execute function gospaza_settlement_deferred('statement_id')`,
  `create constraint trigger settlement_exclusion_consistency after insert or update on settlement_exclusion deferrable initially deferred for each row execute function gospaza_settlement_deferred('statement_id')`,
  `create constraint trigger settlement_source_claim_consistency after insert or update on settlement_source_claim deferrable initially deferred for each row execute function gospaza_settlement_deferred('statement_id')`,
  `create constraint trigger settlement_carry_effect_consistency after insert or update on settlement_carry_effect deferrable initially deferred for each row execute function gospaza_settlement_deferred('statement_id')`,
  `create constraint trigger settlement_carry_claim_consistency after insert or update on settlement_carry_claim deferrable initially deferred for each row execute function gospaza_settlement_deferred('statement_id')`,
  `create constraint trigger payable_settlement_consistency after insert or update on payable_settlement deferrable initially deferred for each row execute function gospaza_settlement_deferred('statement_id')`,
  `create constraint trigger settlement_transition_audit_consistency after insert or update on settlement_transition_audit deferrable initially deferred for each row execute function gospaza_settlement_deferred('statement_id')`,
  `create function gospaza_settlement_evidence_insert() returns trigger as $m20$
  declare parent merchant_period_statement; policy_row settlement_period_policy;
  begin
   select * into strict parent from merchant_period_statement where id=NEW.statement_id;
   select * into strict policy_row from settlement_period_policy where id=parent.policy_id;
   if parent.status<>'DRAFT' or parent.superseded_by is not null or parent.finalized_at is not null or parent.manifest_fingerprint<>'PENDING'
   then raise exception 'Sealed settlement membership' using errcode='23514'; end if;
   if TG_TABLE_NAME='settlement_item' then
    if exists(select 1 from order_finance_exception x where x.snapshot_id=NEW.snapshot_id) then raise exception 'Blocked settlement source' using errcode='23514'; end if;
   else
    if not exists(select 1 from order_finance_snapshot s left join marketplace_finance_posting p on p.snapshot_id=s.id
      where s.id=NEW.snapshot_id and s.merchant_id=parent.merchant_id and s.store_id=parent.store_id and s.currency=parent.currency
      and s.order_id=NEW.order_id and s.recorded_at<=parent.cutoff
      and ((NEW.posting_id is not null and p.id=NEW.posting_id and p.economic_at<parent.period_end and p.recorded_at<=parent.cutoff
        and NEW.held_minor=p.entitlement_minor and ((NEW.reason='HISTORICAL_CATCH_UP' and p.economic_at<policy_row.activation_at)
          or (NEW.reason='UNRESOLVED_FINANCE' and p.economic_at>=policy_row.activation_at and exists(select 1 from order_finance_exception x where x.snapshot_id=s.id))))
        or (NEW.posting_id is null and p.id is null and NEW.held_minor is null and NEW.reason='UNRESOLVED_FINANCE'
          and (s.state='UNRESOLVED' or exists(select 1 from order_finance_exception x where x.snapshot_id=s.id)))))
    then raise exception 'Unproven settlement exclusion' using errcode='23514'; end if;
   end if;
   return NEW;
  end; $m20$ language plpgsql`,
  `create trigger settlement_item_insert before insert on settlement_item for each row execute function gospaza_settlement_evidence_insert()`,
  `create trigger settlement_exclusion_insert before insert on settlement_exclusion for each row execute function gospaza_settlement_evidence_insert()`,
];

