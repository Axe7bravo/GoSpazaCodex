import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261105120000 extends Migration {
  async up():Promise<void> {
    this.addSql("alter table order_finance_exception drop constraint order_finance_exception_reason_check");
    this.addSql(`alter table order_finance_exception add check(reason in
      ('MISSING_COMMISSION_TERMS','UNKNOWN_PROMOTION_SPONSORSHIP','ECONOMIC_EVIDENCE_MISMATCH',
       'RECOGNITION_EVIDENCE_MISMATCH','UNRESOLVED_ADJUSTMENT_ATTRIBUTION','POSTING_SOURCE_CONFLICT'))`);
    this.addSql(`create table marketplace_finance_posting (
      id text primary key, snapshot_id text not null references order_finance_snapshot(id),
      kind text not null check(kind='DELIVERY_RECOGNITION'),
      completion_id text not null references delivery_completion(id),
      event_id text not null references dispatch_event(id), source_revision integer not null check(source_revision>0),
      rule_id text not null references commission_rule(id), policy_version text not null,
      economic_at timestamptz not null, recorded_at timestamptz not null default clock_timestamp(),
      merchandise_minor bigint not null check(merchandise_minor>=0),tax_minor bigint not null check(tax_minor>=0),
      subsidy_minor bigint not null check(subsidy_minor>=0),commission_minor bigint not null check(commission_minor>=0),
      entitlement_minor bigint not null check(entitlement_minor>=0),
      check(entitlement_minor=merchandise_minor+subsidy_minor-commission_minor),
      units jsonb not null check(jsonb_typeof(units)='array' and jsonb_array_length(units)>0),
      source_fingerprint text not null, unique(snapshot_id,kind), unique(kind,completion_id,source_revision)
    )`);
    this.addSql(`create function gospaza_earned_sale_source() returns trigger as $posting$
      begin
        if not exists(select 1 from order_finance_snapshot s
          join delivery_operation d on d.order_operation_id=s.order_operation_id and d.medusa_order_id=s.order_id
            and d.merchant_id=s.merchant_id and d.merchant_store_id=s.store_id
          join delivery_completion c on c.delivery_id=d.id
          join pickup_operation p on p.id=c.ship_operation_id and p.delivery_id=d.id
          join dispatch_commitment k on k.id=c.commitment_id and k.delivery_id=d.id
          join dispatch_event e on e.target_id=d.id and e.target_type='DELIVERY' and e.action='DELIVERED'
          where s.id=NEW.snapshot_id and s.state='RESOLVED' and s.rule_id=NEW.rule_id
            and c.id=NEW.completion_id and c.state='SUCCEEDED' and c.native_done
            and p.state='SUCCEEDED' and p.action='SHIP' and k.status='COMPLETED'
            and c.receipt->>'fulfillment_id'=p.fulfillment_id and p.fulfillment_id=d.native_fulfillment_id
            and d.status='DELIVERED' and d.delivered_at=NEW.economic_at
            and e.id=NEW.event_id and e.revision=NEW.source_revision
            and NEW.commission_minor=floor(((NEW.merchandise_minor::numeric+NEW.subsidy_minor)*s.basis_points+5000)/10000)
            and not exists(select 1 from order_finance_exception x where x.snapshot_id=s.id))
        then raise exception 'Unproven marketplace recognition' using errcode='23514'; end if;
        return NEW;
      end;
      $posting$ language plpgsql`);
    this.addSql(`create trigger marketplace_finance_posting_source before insert on marketplace_finance_posting
      for each row execute function gospaza_earned_sale_source()`);
    this.addSql(`create trigger marketplace_finance_posting_immutable before update or delete on marketplace_finance_posting
      for each row execute function gospaza_commission_immutable()`);
  }
  async down():Promise<void> { throw new Error("Earned marketplace history cannot be destructively rolled back."); }
}
