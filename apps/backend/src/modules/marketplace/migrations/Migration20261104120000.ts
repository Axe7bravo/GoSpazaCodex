import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261104120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`create table commission_rule (
      id text primary key, scope_key text not null,
      merchant_id text references merchant(id), decision text not null check(decision in ('SET','CLEAR')),
      basis_points integer, revision integer not null check(revision>0),
      effective_at timestamptz not null, recorded_at timestamptz not null,
      actor_id text not null, reason text not null check(length(reason) between 1 and 240),
      request_id text not null unique, request_fingerprint text not null,
      check(effective_at>=recorded_at),
      check((merchant_id is null and scope_key='PLATFORM' and decision='SET')
        or (merchant_id is not null and scope_key='MERCHANT:'||merchant_id)),
      check((decision='SET' and basis_points is not null and basis_points between 0 and 10000)
        or (decision='CLEAR' and basis_points is null)),
      unique(scope_key,revision), constraint commission_rule_effective_unique unique(scope_key,effective_at)
    )`);
    this.addSql(`create table commission_rule_audit (
      rule_id text primary key references commission_rule(id),
      actor_id text not null, recorded_at timestamptz not null, request_fingerprint text not null
    )`);
    this.addSql(`create table order_finance_snapshot (
      id text primary key, order_id text not null unique,
      order_operation_id text not null unique references order_operation(id),
      completion_id text not null references checkout_completion(id),
      merchant_id text not null references merchant(id), store_id text not null references merchant_store(id),
      currency text not null check(currency='zar'), order_created_at timestamptz,
      rule_id text references commission_rule(id), merchant_decision_id text references commission_rule(id),
      basis_points integer check(basis_points between 0 and 10000),
      policy_version text not null, evidence jsonb, fingerprint text,
      state text not null check(state in ('RESOLVED','UNRESOLVED')),
      recorded_at timestamptz not null default clock_timestamp(),
      check(state<>'RESOLVED' or (order_created_at is not null and rule_id is not null
        and basis_points is not null and evidence is not null and fingerprint is not null))
    )`);
    this.addSql(`create table order_finance_exception (
      id text primary key, snapshot_id text not null references order_finance_snapshot(id),
      reason text not null check(reason in ('MISSING_COMMISSION_TERMS','UNKNOWN_PROMOTION_SPONSORSHIP','ECONOMIC_EVIDENCE_MISMATCH')),
      source_id text not null, recorded_at timestamptz not null default clock_timestamp(),
      unique(snapshot_id,reason,source_id)
    )`);
    this.addSql(`create function gospaza_commission_immutable() returns trigger as $m19$
      begin raise exception 'Immutable M19 finance history' using errcode='23514'; end;
      $m19$ language plpgsql`);
    for (const table of ["commission_rule", "commission_rule_audit", "order_finance_snapshot", "order_finance_exception"]) {
      this.addSql(`create trigger ${table}_immutable before update or delete on ${table}
        for each row execute function gospaza_commission_immutable()`);
    }
    this.addSql(`create function gospaza_commission_publication() returns trigger as $m19$
      declare publication_time timestamptz;
      begin
        perform pg_advisory_xact_lock(19019001::bigint);
        publication_time := clock_timestamp();
        if NEW.recorded_at is not null then raise exception 'Server publication time required' using errcode='23514'; end if;
        NEW.recorded_at := publication_time;
        if NEW.effective_at is null then
          NEW.effective_at := date_trunc('milliseconds', publication_time);
          if NEW.effective_at < publication_time then NEW.effective_at := NEW.effective_at + interval '1 millisecond'; end if;
        end if;
        if NEW.effective_at < publication_time then raise exception 'Retroactive commission rule'
          using errcode='23514', constraint='commission_rule_no_backdating'; end if;
        if NEW.revision <> coalesce((select max(r.revision) from commission_rule r where r.scope_key=NEW.scope_key),0)+1
          then raise exception 'Commission revision conflict' using errcode='23514'; end if;
        return NEW;
      end;
      $m19$ language plpgsql`);
    this.addSql(`create trigger commission_publication before insert on commission_rule
      for each row execute function gospaza_commission_publication()`);
    this.addSql(`create function gospaza_commission_audit_check() returns trigger as $m19$
      begin
        if not exists(select 1 from commission_rule_audit a where a.rule_id=NEW.id
          and a.actor_id=NEW.actor_id and a.recorded_at=NEW.recorded_at and a.request_fingerprint=NEW.request_fingerprint)
          then raise exception 'Commission publication requires matching audit' using errcode='23514'; end if;
        return NEW;
      end;
      $m19$ language plpgsql`);
    this.addSql(`create constraint trigger commission_audit_consistency after insert on commission_rule
      deferrable initially deferred for each row execute function gospaza_commission_audit_check()`);
    this.addSql(`create function gospaza_order_finance_identity() returns trigger as $m19$
      begin
        if not exists(select 1 from order_operation o join checkout_completion c on c.id=o.checkout_completion_id
          join merchant_store s on s.id=o.merchant_store_id and s.merchant_id=o.merchant_id
          where o.id=NEW.order_operation_id and o.medusa_order_id=NEW.order_id
          and o.merchant_id=NEW.merchant_id and o.merchant_store_id=NEW.store_id
          and c.id=NEW.completion_id and c.order_id=NEW.order_id and c.state='SUCCEEDED')
          then raise exception 'Order finance identity mismatch' using errcode='23514'; end if;
        if NEW.rule_id is not null and not exists(select 1 from commission_rule r where r.id=NEW.rule_id
          and r.decision='SET' and r.basis_points=NEW.basis_points and r.effective_at<=NEW.order_created_at
          and (r.merchant_id is null or r.merchant_id=NEW.merchant_id))
          then raise exception 'Order finance rule mismatch' using errcode='23514'; end if;
        return NEW;
      end;
      $m19$ language plpgsql`);
    this.addSql(`create trigger order_finance_identity before insert on order_finance_snapshot
      for each row execute function gospaza_order_finance_identity()`);
    this.addSql(`create function gospaza_order_finance_exception_check() returns trigger as $m19$
      begin
        if NEW.state='UNRESOLVED' and not exists(select 1 from order_finance_exception e where e.snapshot_id=NEW.id)
          then raise exception 'Unresolved finance requires exception' using errcode='23514'; end if;
        return NEW;
      end;
      $m19$ language plpgsql`);
    this.addSql(`create constraint trigger order_finance_exception_consistency after insert on order_finance_snapshot
      deferrable initially deferred for each row execute function gospaza_order_finance_exception_check()`);
  }
  async down(): Promise<void> {
    throw new Error("M19 historical finance cannot be destructively rolled back.");
  }
}
