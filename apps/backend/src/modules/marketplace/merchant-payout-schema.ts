import { merchantSettlementSql } from "./merchant-settlement-schema";

// Forward extension of the verified B check: only payable lifecycle status may
// advance beyond the immutable prepared statement. All economic checks remain.
const preparation = merchantSettlementSql.find(sql=>sql.startsWith("create function gospaza_settlement_consistent("));
const oldComparison = "(amount_minor,currency,status)<>(statement_row.payable_minor,statement_row.currency,statement_row.status)";
if(!preparation || preparation.split(oldComparison).length!==2) throw new Error("M20-B payable consistency definition changed.");
const extendedPreparation = preparation.replace("create function","create or replace function").replace(oldComparison,
  "((amount_minor,currency)<>(statement_row.payable_minor,statement_row.currency) or not (status=statement_row.status or (statement_row.status='READY_FOR_APPROVAL' and status in ('APPROVED','FAILED','PAID','RECONCILED'))))");

export const merchantPayoutSql: readonly string[] = [
  extendedPreparation,
  `alter table payable_settlement add column revision integer not null default 1 check(revision>0)`,
  `alter table payable_settlement drop constraint payable_settlement_status_check`,
  `alter table payable_settlement add constraint payable_settlement_status_check check(status in ('DRAFT','READY_FOR_APPROVAL','APPROVED','FAILED','PAID','RECONCILED'))`,
  `create table merchant_settlement_command(id text primary key,payable_id text not null references payable_settlement(id),action text not null check(action in ('APPROVE','PAY','FAIL','RETRY','RECONCILE','DISCREPANCY')),actor_id text not null,recorded_at timestamptz not null default clock_timestamp(),prior_revision integer not null,new_revision integer not null,from_status text not null,to_status text not null,request_id text not null unique,request_fingerprint text not null,reason text not null check(length(reason) between 1 and 240),confirmed boolean not null check(confirmed),amount_minor bigint not null check(amount_minor>0),currency text not null check(currency='zar'),check((action='DISCREPANCY' and new_revision=prior_revision and from_status=to_status) or (action<>'DISCREPANCY' and new_revision=prior_revision+1)))`,
  `create unique index merchant_settlement_one_transition on merchant_settlement_command(payable_id,new_revision) where action<>'DISCREPANCY'`,
  `create table merchant_payout_identity(id text primary key,payable_id text not null references payable_settlement(id),command_id text not null unique references merchant_settlement_command(id),channel text not null check(channel='BANK_TRANSFER'),origin_reference text not null check(length(origin_reference) between 1 and 120),external_transfer_id text not null check(length(external_transfer_id) between 1 and 120),constraint merchant_payout_transfer_unique unique(channel,origin_reference,external_transfer_id))`,
  `create table merchant_payout_receipt(id text primary key,payable_id text not null unique references payable_settlement(id),statement_id text not null references merchant_period_statement(id),merchant_id text not null references merchant(id),store_id text not null references merchant_store(id),command_id text not null unique references merchant_settlement_command(id),approval_command_id text not null references merchant_settlement_command(id),identity_id text not null unique references merchant_payout_identity(id),amount_minor bigint not null check(amount_minor>0),currency text not null check(currency='zar'),beneficiary_reference text not null check(length(beneficiary_reference) between 1 and 120),transferred_at timestamptz not null,recorded_at timestamptz not null default clock_timestamp(),evidence_reference text)`,
  `create table merchant_payout_failure(id text primary key,payable_id text not null references payable_settlement(id),command_id text not null unique references merchant_settlement_command(id),approval_command_id text not null references merchant_settlement_command(id),identity_id text unique references merchant_payout_identity(id),beneficiary_reference text not null check(length(beneficiary_reference) between 1 and 120),channel text not null check(channel='BANK_TRANSFER'),origin_reference text not null check(length(origin_reference) between 1 and 120),attempted_at timestamptz not null,failure_category text not null check(failure_category in ('BANK_REJECTED','RETURNED_BEFORE_RECEIPT','RAIL_CONFIRMED_FAILURE')),nonreceipt_confirmed boolean not null check(nonreceipt_confirmed),evidence_reference text not null check(length(evidence_reference) between 1 and 120),recorded_at timestamptz not null default clock_timestamp())`,
  `create table merchant_payout_retry(command_id text primary key references merchant_settlement_command(id),failed_attempt_id text not null unique references merchant_payout_failure(id),review_reference text not null check(length(review_reference) between 1 and 120))`,
  `create table merchant_payout_reconciliation(command_id text primary key references merchant_settlement_command(id),payable_id text not null unique references payable_settlement(id),receipt_id text not null unique references merchant_payout_receipt(id),review_reference text not null check(length(review_reference) between 1 and 120))`,
  `create table merchant_settlement_discrepancy(id text primary key,payable_id text not null references payable_settlement(id),command_id text not null unique references merchant_settlement_command(id),category text not null check(category in ('UNKNOWN_OUTCOME','RETURNED_TRANSFER','BENEFICIARY_MISMATCH','AMOUNT_MISMATCH','TRANSFER_DISPUTE','DUPLICATE_EXTERNAL_RECORD','RECONCILIATION_MISMATCH')),status text not null default 'OPEN' check(status='OPEN'),evidence_reference text not null check(length(evidence_reference) between 1 and 120),recorded_at timestamptz not null default clock_timestamp())`,
  `create trigger merchant_settlement_command_immutable before update or delete on merchant_settlement_command for each row execute function gospaza_settlement_immutable()`,
  `create trigger merchant_payout_identity_immutable before update or delete on merchant_payout_identity for each row execute function gospaza_settlement_immutable()`,
  `create trigger merchant_payout_receipt_immutable before update or delete on merchant_payout_receipt for each row execute function gospaza_settlement_immutable()`,
  `create trigger merchant_payout_failure_immutable before update or delete on merchant_payout_failure for each row execute function gospaza_settlement_immutable()`,
  `create trigger merchant_payout_retry_immutable before update or delete on merchant_payout_retry for each row execute function gospaza_settlement_immutable()`,
  `create trigger merchant_payout_reconciliation_immutable before update or delete on merchant_payout_reconciliation for each row execute function gospaza_settlement_immutable()`,
  `create trigger merchant_settlement_discrepancy_immutable before update or delete on merchant_settlement_discrepancy for each row execute function gospaza_settlement_immutable()`,
  `create function gospaza_merchant_command_guard() returns trigger as $m20c$
declare payable_row payable_settlement; statement_row merchant_period_statement; expected_state text;
begin
 select * into strict payable_row from payable_settlement where id=NEW.payable_id;
 select * into strict statement_row from merchant_period_statement where id=payable_row.statement_id;
 perform 1 from merchant where id=statement_row.merchant_id for update;
 select * into strict payable_row from payable_settlement where id=NEW.payable_id for update;
 if NEW.prior_revision<>payable_row.revision or NEW.from_status<>payable_row.status or NEW.amount_minor<>payable_row.amount_minor or NEW.currency<>payable_row.currency or not NEW.confirmed or statement_row.superseded_by is not null then raise exception 'Merchant settlement command conflict' using errcode='23514'; end if;
 NEW.recorded_at:=clock_timestamp();
 if NEW.action='DISCREPANCY' then
  if payable_row.status='DRAFT' or NEW.to_status<>payable_row.status or NEW.new_revision<>payable_row.revision then raise exception 'Discrepancy state conflict' using errcode='23514'; end if;
  return NEW;
 end if;
 expected_state:=case when NEW.action='APPROVE' and payable_row.status='READY_FOR_APPROVAL' then 'APPROVED'
  when NEW.action='PAY' and payable_row.status='APPROVED' then 'PAID'
  when NEW.action='FAIL' and payable_row.status='APPROVED' then 'FAILED'
  when NEW.action='RETRY' and payable_row.status='FAILED' then 'APPROVED'
  when NEW.action='RECONCILE' and payable_row.status='PAID' then 'RECONCILED' else null end;
 if expected_state is null or NEW.to_status<>expected_state or NEW.new_revision<>payable_row.revision+1 then raise exception 'Merchant settlement transition denied' using errcode='23514'; end if;
 if NEW.action<>'FAIL' and exists(select 1 from merchant_settlement_discrepancy d where d.payable_id=NEW.payable_id and d.status='OPEN') then raise exception 'Unresolved merchant payment discrepancy' using errcode='23514'; end if;
 perform gospaza_settlement_consistent(payable_row.statement_id);
 return NEW;
end; $m20c$ language plpgsql`,
  `create trigger merchant_settlement_command_guard before insert on merchant_settlement_command for each row execute function gospaza_merchant_command_guard()`,
  `create or replace function gospaza_settlement_payable_guard() returns trigger as $m20c$
begin
 if TG_OP='DELETE' then raise exception 'Immutable payable settlement' using errcode='23514'; end if;
 if TG_OP='INSERT' then
  if NEW.status<>'DRAFT' or NEW.revision<>1 or not exists(select 1 from merchant_period_statement s where s.id=NEW.statement_id and s.payable_minor=NEW.amount_minor and s.currency=NEW.currency and s.status='DRAFT' and s.superseded_by is null) then raise exception 'Payable initial identity mismatch' using errcode='23514'; end if;
  return NEW;
 end if;
 if (to_jsonb(NEW)-array['status','revision'])<>(to_jsonb(OLD)-array['status','revision']) then raise exception 'Immutable payable economics' using errcode='23514'; end if;
 if OLD.status='DRAFT' and NEW.status='READY_FOR_APPROVAL' and NEW.revision=OLD.revision then
  if not exists(select 1 from merchant_period_statement s where s.id=NEW.statement_id and s.status='READY_FOR_APPROVAL' and s.superseded_by is null) then raise exception 'Payable readiness mismatch' using errcode='23514'; end if;
  return NEW;
 end if;
 if OLD.status='RECONCILED' or NEW.revision<>OLD.revision+1 or not exists(select 1 from merchant_settlement_command a where a.payable_id=NEW.id and a.action<>'DISCREPANCY' and a.from_status=OLD.status and a.to_status=NEW.status and a.prior_revision=OLD.revision and a.new_revision=NEW.revision and a.amount_minor=NEW.amount_minor and a.currency=NEW.currency) then raise exception 'Unproven payable transition' using errcode='23514'; end if;
 return NEW;
end; $m20c$ language plpgsql`,
  `create function gospaza_merchant_payment_evidence_guard() returns trigger as $m20c$
declare command_row merchant_settlement_command; payable_row payable_settlement; statement_row merchant_period_statement; approval_row merchant_settlement_command; identity_row merchant_payout_identity; actual_time timestamptz;
begin
 select * into strict command_row from merchant_settlement_command where id=NEW.command_id;
 select * into strict payable_row from payable_settlement where id=command_row.payable_id;
 if NEW.payable_id<>payable_row.id then raise exception 'Merchant payment source mismatch' using errcode='23514'; end if;
 if TG_TABLE_NAME='merchant_payout_identity' then
  if command_row.action not in ('PAY','FAIL') then raise exception 'Merchant transfer identity action' using errcode='23514'; end if;
  return NEW;
 end if;
 if TG_TABLE_NAME='merchant_settlement_discrepancy' then
  if command_row.action<>'DISCREPANCY' then raise exception 'Discrepancy audit mismatch' using errcode='23514'; end if;
  NEW.recorded_at:=clock_timestamp(); return NEW;
 end if;
 select * into strict approval_row from merchant_settlement_command where payable_id=payable_row.id and action in ('APPROVE','RETRY') order by new_revision desc limit 1;
 if NEW.approval_command_id<>approval_row.id then raise exception 'Payout approval evidence mismatch' using errcode='23514'; end if;
 if NEW.identity_id is not null then
  select * into strict identity_row from merchant_payout_identity where id=NEW.identity_id;
  if identity_row.payable_id<>payable_row.id or identity_row.command_id<>NEW.command_id then raise exception 'Payout identity mismatch' using errcode='23514'; end if;
 end if;
 if TG_TABLE_NAME='merchant_payout_receipt' then
  select * into strict statement_row from merchant_period_statement where id=payable_row.statement_id;
  if command_row.action<>'PAY' or (NEW.statement_id,NEW.merchant_id,NEW.store_id,NEW.amount_minor,NEW.currency) is distinct from (statement_row.id,statement_row.merchant_id,statement_row.store_id,payable_row.amount_minor,payable_row.currency) or NEW.identity_id is null then raise exception 'Payout receipt mismatch' using errcode='23514'; end if;
  actual_time:=NEW.transferred_at;
 else
  if command_row.action<>'FAIL' or not NEW.nonreceipt_confirmed or exists(select 1 from merchant_payout_receipt r where r.payable_id=NEW.payable_id)
   or (NEW.identity_id is not null and (identity_row.channel,identity_row.origin_reference) is distinct from (NEW.channel,NEW.origin_reference)) then raise exception 'Failed payout evidence mismatch' using errcode='23514'; end if;
  actual_time:=NEW.attempted_at;
 end if;
 if actual_time<approval_row.recorded_at or actual_time>clock_timestamp() then raise exception 'Invalid external transfer time' using errcode='23514', constraint='merchant_payout_time'; end if;
 NEW.recorded_at:=clock_timestamp();return NEW;
end; $m20c$ language plpgsql`,
  `create trigger merchant_payout_identity_source before insert on merchant_payout_identity for each row execute function gospaza_merchant_payment_evidence_guard()`,
  `create trigger merchant_payout_receipt_source before insert on merchant_payout_receipt for each row execute function gospaza_merchant_payment_evidence_guard()`,
  `create trigger merchant_payout_failure_source before insert on merchant_payout_failure for each row execute function gospaza_merchant_payment_evidence_guard()`,
  `create trigger merchant_settlement_discrepancy_source before insert on merchant_settlement_discrepancy for each row execute function gospaza_merchant_payment_evidence_guard()`,
  `create function gospaza_merchant_review_guard() returns trigger as $m20c$
declare command_row merchant_settlement_command;
begin
 select * into strict command_row from merchant_settlement_command where id=NEW.command_id;
 if TG_TABLE_NAME='merchant_payout_retry' then
  if command_row.action<>'RETRY' or not exists(select 1 from merchant_payout_failure f join merchant_settlement_command failed on failed.id=f.command_id where f.id=NEW.failed_attempt_id and f.payable_id=command_row.payable_id and failed.new_revision=command_row.prior_revision) then raise exception 'Retry failure review mismatch' using errcode='23514'; end if;
 else
  if command_row.action<>'RECONCILE' or NEW.payable_id<>command_row.payable_id or not exists(select 1 from merchant_payout_receipt r where r.id=NEW.receipt_id and r.payable_id=NEW.payable_id and r.amount_minor=command_row.amount_minor and r.currency=command_row.currency) or exists(select 1 from merchant_settlement_discrepancy d where d.payable_id=NEW.payable_id and d.status='OPEN') then raise exception 'Reconciliation evidence mismatch' using errcode='23514'; end if;
 end if;
 return NEW;
end; $m20c$ language plpgsql`,
  `create trigger merchant_payout_retry_source before insert on merchant_payout_retry for each row execute function gospaza_merchant_review_guard()`,
  `create trigger merchant_payout_reconciliation_source before insert on merchant_payout_reconciliation for each row execute function gospaza_merchant_review_guard()`,
  `create function gospaza_merchant_payout_consistent(target text) returns void as $m20c$
declare payable_row payable_settlement; action_row merchant_settlement_command; expected_state text:='READY_FOR_APPROVAL'; expected_revision integer:=1;
begin
 select * into strict payable_row from payable_settlement where id=target;
 for action_row in select * from merchant_settlement_command where payable_id=target and action<>'DISCREPANCY' order by new_revision loop
  if action_row.prior_revision<>expected_revision or action_row.from_status<>expected_state or action_row.amount_minor<>payable_row.amount_minor or action_row.currency<>payable_row.currency then raise exception 'Payout audit chain mismatch' using errcode='23514'; end if;
  if action_row.action='PAY' then
   if not exists(select 1 from merchant_payout_receipt r join merchant_payout_identity i on i.id=r.identity_id where r.command_id=action_row.id and r.payable_id=target and i.command_id=action_row.id) then raise exception 'Successful payout requires receipt and identity' using errcode='23514'; end if;
  elsif action_row.action='FAIL' then
   if not exists(select 1 from merchant_payout_failure f where f.command_id=action_row.id and f.payable_id=target and f.nonreceipt_confirmed and ((f.identity_id is null and not exists(select 1 from merchant_payout_identity i where i.command_id=action_row.id)) or exists(select 1 from merchant_payout_identity i where i.id=f.identity_id and i.command_id=action_row.id))) then raise exception 'Failed payout requires nonreceipt evidence' using errcode='23514'; end if;
  elsif action_row.action='RETRY' then
   if not exists(select 1 from merchant_payout_retry r where r.command_id=action_row.id) then raise exception 'Retry requires reviewed failure' using errcode='23514'; end if;
  elsif action_row.action='RECONCILE' then
   if not exists(select 1 from merchant_payout_reconciliation r where r.command_id=action_row.id and r.payable_id=target)
    or exists(select 1 from merchant_settlement_discrepancy d join merchant_settlement_command attention on attention.id=d.command_id where d.payable_id=target and attention.prior_revision<=action_row.prior_revision and d.status='OPEN') then raise exception 'Reconciliation requires reviewed undisputed receipt' using errcode='23514'; end if;
  end if;
  expected_state:=action_row.to_status;expected_revision:=action_row.new_revision;
 end loop;
 if expected_revision=1 then
  if payable_row.status not in ('DRAFT','READY_FOR_APPROVAL') or payable_row.revision<>1 then raise exception 'Unproven initial payout state' using errcode='23514'; end if;
 elsif payable_row.status<>expected_state or payable_row.revision<>expected_revision then raise exception 'Payout audit/state mismatch' using errcode='23514'; end if;
 if exists(select 1 from merchant_settlement_command a where a.payable_id=target and a.action='DISCREPANCY' and not exists(select 1 from merchant_settlement_discrepancy d where d.command_id=a.id and d.payable_id=target)) then raise exception 'Discrepancy audit requires evidence' using errcode='23514'; end if;
 if payable_row.status in ('PAID','RECONCILED') and not exists(select 1 from merchant_payout_receipt r where r.payable_id=target) then raise exception 'Paid settlement requires receipt' using errcode='23514'; end if;
end; $m20c$ language plpgsql`,
  `create function gospaza_merchant_payout_deferred() returns trigger as $m20c$
declare target text;
begin
 if TG_TABLE_NAME='payable_settlement' then target:=NEW.id;
 elsif TG_TABLE_NAME in ('merchant_payout_retry','merchant_payout_reconciliation') then select a.payable_id into strict target from merchant_settlement_command a where a.id=NEW.command_id;
 else target:=NEW.payable_id; end if;
 perform gospaza_merchant_payout_consistent(target);return NEW;
end; $m20c$ language plpgsql`,
  `create constraint trigger payable_settlement_payout_consistency after insert or update on payable_settlement deferrable initially deferred for each row execute function gospaza_merchant_payout_deferred()`,
  `create constraint trigger merchant_settlement_command_payout_consistency after insert or update on merchant_settlement_command deferrable initially deferred for each row execute function gospaza_merchant_payout_deferred()`,
  `create constraint trigger merchant_payout_identity_payout_consistency after insert or update on merchant_payout_identity deferrable initially deferred for each row execute function gospaza_merchant_payout_deferred()`,
  `create constraint trigger merchant_payout_receipt_payout_consistency after insert or update on merchant_payout_receipt deferrable initially deferred for each row execute function gospaza_merchant_payout_deferred()`,
  `create constraint trigger merchant_payout_failure_payout_consistency after insert or update on merchant_payout_failure deferrable initially deferred for each row execute function gospaza_merchant_payout_deferred()`,
  `create constraint trigger merchant_payout_retry_payout_consistency after insert or update on merchant_payout_retry deferrable initially deferred for each row execute function gospaza_merchant_payout_deferred()`,
  `create constraint trigger merchant_payout_reconciliation_payout_consistency after insert or update on merchant_payout_reconciliation deferrable initially deferred for each row execute function gospaza_merchant_payout_deferred()`,
  `create constraint trigger merchant_settlement_discrepancy_payout_consistency after insert or update on merchant_settlement_discrepancy deferrable initially deferred for each row execute function gospaza_merchant_payout_deferred()`,
];

