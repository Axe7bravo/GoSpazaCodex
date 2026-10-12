import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261011100000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table order_operation drop constraint order_operation_b_pending;
      alter table order_operation
        add column accepted_at timestamptz,
        add column rejected_at timestamptz,
        add column decided_by_member_id text references merchant_member(id) on delete restrict,
        add column rejection_reason text,
        add constraint order_decision_shape check (
          (status = 'PENDING_ACCEPTANCE' and revision = 0 and accepted_at is null and rejected_at is null
            and decided_by_member_id is null and rejection_reason is null)
          or (status = 'ACCEPTED' and revision = 1 and accepted_at is not null and rejected_at is null
            and decided_by_member_id is not null and rejection_reason is null)
          or (status = 'REJECTED' and revision = 1 and accepted_at is null and rejected_at is not null
            and decided_by_member_id is not null)),
        add constraint order_reason_bounded check (rejection_reason is null or
          (length(rejection_reason) between 1 and 500 and rejection_reason = btrim(rejection_reason)));
      create table order_decision_event (
        id text primary key,
        order_operation_id text not null unique references order_operation(id) on delete restrict,
        merchant_id text not null references merchant(id) on delete restrict,
        merchant_store_id text not null,
        decided_by_member_id text not null references merchant_member(id) on delete restrict,
        from_status text not null check(from_status = 'PENDING_ACCEPTANCE'),
        to_status text not null check(to_status in ('ACCEPTED','REJECTED')),
        reason text check(reason is null or (length(reason) between 1 and 500 and reason = btrim(reason))),
        decided_at timestamptz not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz check(deleted_at is null),
        foreign key (merchant_store_id, merchant_id) references merchant_store(id, merchant_id) on delete restrict,
        check(to_status = 'REJECTED' or reason is null)
      );
      create function gospaza_order_decision_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP = 'INSERT' and new.status <> 'PENDING_ACCEPTANCE' then
          raise exception 'Order must begin pending acceptance';
        end if;
        if TG_OP = 'UPDATE' then
          if old.status <> 'PENDING_ACCEPTANCE' and new is distinct from old then
            raise exception 'Merchant decision is immutable';
          end if;
          if new.status <> old.status and not exists (
            select 1 from merchant_member m where m.id = new.decided_by_member_id
              and m.merchant_id = new.merchant_id and m.status = 'ACTIVE'
              and m.member_type in ('OWNER','MANAGER') and m.deleted_at is null
          ) then raise exception 'Active deciding member required'; end if;
        end if;
        return new;
      end; $$;
      create trigger order_decision_guard before insert or update on order_operation
        for each row execute function gospaza_order_decision_guard();

      create function gospaza_order_decision_audit_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP = 'UPDATE' then raise exception 'Order decision audit is append-only'; end if;
        if not exists (select 1 from order_operation o where o.id = new.order_operation_id
          and o.status = new.to_status and o.merchant_id = new.merchant_id and o.merchant_store_id = new.merchant_store_id
          and o.decided_by_member_id = new.decided_by_member_id
          and o.rejection_reason is not distinct from new.reason
          and coalesce(o.accepted_at,o.rejected_at) = new.decided_at and o.deleted_at is null)
        then raise exception 'Decision audit must match the authoritative transition'; end if;
        return new;
      end; $$;
      create trigger order_decision_audit_guard before insert or update on order_decision_event
        for each row execute function gospaza_order_decision_audit_guard();

      -- Deferred validation makes decision + audit + capacity one commit.
      create function gospaza_order_decision_complete() returns trigger language plpgsql as $$
      declare o order_operation;
      begin
        select * into o from order_operation where id = new.id;
        if not found or o.status = 'PENDING_ACCEPTANCE' then return null; end if;
        if not exists (select 1 from order_decision_event e where e.order_operation_id = o.id
          and e.to_status = o.status and e.decided_by_member_id = o.decided_by_member_id
          and e.reason is not distinct from o.rejection_reason and e.decided_at = coalesce(o.accepted_at,o.rejected_at)
          and e.merchant_id = o.merchant_id and e.merchant_store_id = o.merchant_store_id and e.deleted_at is null)
        then raise exception 'Terminal decision requires its audit'; end if;
        if not exists (
          select 1 from checkout_completion c join checkout_attempt a on a.id = c.checkout_attempt_id
          join delivery_reservation r on r.id = a.reservation_id
          where c.id = o.checkout_completion_id and c.state = 'SUCCEEDED' and a.state = 'COMPLETED'
            and r.medusa_order_id = o.medusa_order_id and r.merchant_store_id = o.merchant_store_id
            and r.payment_accepted_at is not null
            and ((o.status = 'ACCEPTED' and r.status = 'COMMITTED') or
              (o.status = 'REJECTED' and r.status = 'RELEASED' and r.release_reason = 'ORDER_REJECTED'
                and r.released_at = o.rejected_at))
        ) then raise exception 'Decision and delivery capacity must commit together'; end if;
        return null;
      end; $$;
      create constraint trigger order_decision_complete after insert or update on order_operation
        deferrable initially deferred for each row execute function gospaza_order_decision_complete();

      -- Preserve historical Order correlation after the sole permitted release.
      alter table delivery_reservation drop constraint delivery_committed_order;
      alter table delivery_reservation add constraint delivery_committed_order check (
        (status = 'COMMITTED' and medusa_order_id is not null) or
        (status = 'RELEASED' and medusa_order_id is not null and release_reason is not null and release_reason = 'ORDER_REJECTED' and released_at is not null) or
        (status not in ('COMMITTED') and medusa_order_id is null));
      create or replace function gospaza_reservation_payment_deadline() returns trigger language plpgsql as $$
      begin
        if old.status = 'COMMITTED' and new.status = 'RELEASED' then
          if new.release_reason is distinct from 'ORDER_REJECTED' or new.released_at is null
            or new.selection_revision <> old.selection_revision + 1
            or (to_jsonb(new) - array['status','released_at','release_reason','selection_revision','updated_at'])
              is distinct from (to_jsonb(old) - array['status','released_at','release_reason','selection_revision','updated_at'])
            or not exists (
              select 1 from order_operation o join order_decision_event e on e.order_operation_id = o.id
              join checkout_completion c on c.id = o.checkout_completion_id
              join checkout_attempt a on a.id = c.checkout_attempt_id
              where a.reservation_id = old.id and o.medusa_order_id = old.medusa_order_id
                and o.merchant_store_id = old.merchant_store_id and o.status = 'REJECTED'
                and o.rejected_at = new.released_at and e.to_status = 'REJECTED'
                and e.decided_at = o.rejected_at and o.deleted_at is null and e.deleted_at is null
            ) then raise exception 'Audited merchant rejection required to release committed capacity'; end if;
          return new;
        end if;
        if old.status = 'RELEASED' and old.medusa_order_id is not null and new is distinct from old then
          raise exception 'Rejected order capacity is immutable';
        end if;
        if (old.payment_deadline is not null and
          (old.payment_deadline is distinct from new.payment_deadline or new.status = 'HELD'))
          or (old.payment_accepted_at is not null and (old.payment_accepted_at is distinct from new.payment_accepted_at
            or new.status not in ('PAYMENT_PENDING','COMMITTED')))
          or (old.status = 'COMMITTED' and (new.status <> 'COMMITTED' or old.medusa_order_id is distinct from new.medusa_order_id)) then
          raise exception 'Payment capacity commitment is immutable';
        end if;
        return new;
      end; $$;

      create function gospaza_rejected_capacity_provenance() returns trigger language plpgsql as $$
      begin
        if new.status = 'RELEASED' and new.medusa_order_id is not null and not exists (
          select 1 from order_operation o join order_decision_event e on e.order_operation_id = o.id
          join checkout_completion c on c.id = o.checkout_completion_id
          join checkout_attempt a on a.id = c.checkout_attempt_id
          where a.reservation_id = new.id and a.state = 'COMPLETED' and c.state = 'SUCCEEDED'
            and o.medusa_order_id = new.medusa_order_id and o.merchant_store_id = new.merchant_store_id
            and o.status = 'REJECTED' and o.rejected_at = new.released_at
            and e.to_status = 'REJECTED' and e.decided_at = new.released_at
            and o.deleted_at is null and e.deleted_at is null
        ) then raise exception 'Released order capacity requires retained rejection provenance'; end if;
        return null;
      end; $$;
      create constraint trigger rejected_capacity_provenance after insert or update on delivery_reservation
        deferrable initially deferred for each row execute function gospaza_rejected_capacity_provenance();
    `);
  }
  async down(): Promise<void> {
    throw new Error("M11 decision history requires an explicit forward migration.");
  }
}
