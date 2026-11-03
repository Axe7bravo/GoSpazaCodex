import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20261031120200 extends Migration {
  async up():Promise<void> {
    this.addSql(`create table checkout_credit_redemption (
      attempt_id text primary key references checkout_attempt(id), customer_id text not null, account_id text not null,
      amount_minor bigint not null check(amount_minor>0), gross_minor bigint not null, external_minor bigint not null check(external_minor>=200),
      currency text not null check(currency='zar'), native_debit_id text not null unique, restore_id text unique,
      spent_at timestamptz not null default now(), restored_at timestamptz,
      check(gross_minor=amount_minor+external_minor), check((restored_at is null)=(restore_id is null))
    );`);
    this.addSql(`create function gospaza_redemption_guard() returns trigger as $redeem$
      declare attempt checkout_attempt;
      begin
        if TG_OP='DELETE' then raise exception 'Redemption history immutable'; end if;
        select * into strict attempt from checkout_attempt where id=NEW.attempt_id for update;
        if TG_OP='INSERT' and (attempt.state<>'PAYMENT_PENDING' or attempt.closed_at is not null
          or attempt.payment_deadline is null or attempt.payment_deadline<=clock_timestamp()
          or NEW.restore_id is not null
          or attempt.snapshot->>'customer_id' is distinct from NEW.customer_id
          or attempt.snapshot#>>'{store_credit,account_id}' is distinct from NEW.account_id
          or (attempt.snapshot#>>'{store_credit,amount_minor}')::bigint is distinct from NEW.amount_minor
          or (attempt.snapshot#>>'{totals,total_minor}')::bigint is distinct from NEW.external_minor
          or (attempt.snapshot#>>'{store_credit,gross_minor}')::bigint is distinct from NEW.gross_minor)
          then raise exception 'Redemption authority'; end if;
        if TG_OP='UPDATE' and ((to_jsonb(NEW)-array['restored_at','restore_id']) is distinct from (to_jsonb(OLD)-array['restored_at','restore_id'])
          or OLD.restore_id is not null or NEW.restore_id is null or attempt.closed_at is null
          or attempt.payment_accepted_at is not null or attempt.state not in ('FAILED','EXPIRED','ABANDONED','SUPERSEDED')
          or exists(select 1 from checkout_completion c where c.checkout_attempt_id=attempt.id))
          then raise exception 'Redemption restoration authority'; end if;
        return NEW;
      end;
      $redeem$ language plpgsql;`);
    this.addSql(`create trigger redemption_guard before insert or update or delete on checkout_credit_redemption for each row execute function gospaza_redemption_guard();`);
  }
  async down():Promise<void> { throw new Error("Financial history requires a forward migration."); }
}
