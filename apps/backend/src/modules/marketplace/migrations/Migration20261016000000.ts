import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261016000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table order_shortage_preference (
        id text primary key, order_operation_id text not null unique references order_operation(id) on delete restrict,
        preference text not null default 'CONTACT_ME' check(preference in ('CONTACT_ME','NO_SUBSTITUTION')),
        customer_id text, chosen_at timestamptz, frozen_at timestamptz,
        revision integer not null default 1 check(revision > 0),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz check(deleted_at is null),
        check((customer_id is null) = (chosen_at is null)),
        check(preference <> 'NO_SUBSTITUTION' or customer_id is not null)
      );
      create table shortage_resolution (
        id text primary key, order_operation_id text not null references order_operation(id) on delete restrict,
        pick_session_id text not null references pick_session(id) on delete restrict,
        pick_line_id text not null references pick_line(id) on delete restrict,
        preference_id text not null references order_shortage_preference(id) on delete restrict,
        status text not null check(status in ('CUSTOMER_DECISION_REQUIRED','RESOLVED_OMITTED')),
        revision integer not null default 1 check(revision > 0), evidence jsonb not null,
        decision_customer_id text, resolved_at timestamptz, invalidated_at timestamptz,
        financial_review_required boolean not null default false,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz check(deleted_at is null),
        check(jsonb_typeof(evidence) = 'object'),
        check(evidence ?& array['ordered','picked','missing','native_order_id','native_line_id','checkout_completion_id','source_lines_fingerprint','preference','preference_revision']),
        check(jsonb_typeof(evidence->'ordered')='number' and jsonb_typeof(evidence->'picked')='number' and jsonb_typeof(evidence->'missing')='number'),
        check((evidence->>'ordered')::numeric between 1 and 9007199254740991),
        check((evidence->>'picked')::numeric >= 0 and (evidence->>'missing')::numeric > 0),
        check((evidence->>'ordered')::numeric = (evidence->>'picked')::numeric + (evidence->>'missing')::numeric),
        check((evidence->>'ordered')::numeric = trunc((evidence->>'ordered')::numeric)
          and (evidence->>'picked')::numeric = trunc((evidence->>'picked')::numeric)),
        check((status = 'RESOLVED_OMITTED' and resolved_at is not null and financial_review_required and invalidated_at is null)
          or (status = 'CUSTOMER_DECISION_REQUIRED' and resolved_at is null and not financial_review_required and decision_customer_id is null))
      );
      create unique index shortage_resolution_current on shortage_resolution(pick_line_id) where invalidated_at is null;
      create table shortage_event (
        id text primary key, order_operation_id text not null references order_operation(id) on delete restrict,
        shortage_resolution_id text references shortage_resolution(id) on delete restrict,
        action text not null, actor_type text not null check(actor_type in ('customer','merchant','system')),
        actor_id text, evidence jsonb not null, occurred_at timestamptz not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz check(deleted_at is null),
        check(jsonb_typeof(evidence) = 'object'), check((actor_type = 'system') = (actor_id is null))
      );
      create function gospaza_shortage_preference_guard() returns trigger language plpgsql as $$
      declare customer text;
      begin
        select a.snapshot->>'customer_id' into customer from order_operation o
          join checkout_completion c on c.id=o.checkout_completion_id join checkout_attempt a on a.id=c.checkout_attempt_id
          join delivery_reservation r on r.id=a.reservation_id
          where o.id=new.order_operation_id and o.status in ('PENDING_ACCEPTANCE','ACCEPTED') and c.state='SUCCEEDED' and c.native_state='done' and c.terminal_receipt is not null
            and c.order_id=o.medusa_order_id and a.state='COMPLETED' and r.status='COMMITTED' and r.medusa_order_id=o.medusa_order_id;
        if customer is null or (new.customer_id is not null and new.customer_id <> customer) then raise exception 'Owned authoritative order required'; end if;
        if TG_OP='UPDATE' then
          if old.frozen_at is not null or new.id<>old.id or new.order_operation_id<>old.order_operation_id
            or new.revision<>old.revision+1 then raise exception 'Frozen preference is immutable'; end if;
          if new.frozen_at is not null and (new.preference<>old.preference or new.customer_id is distinct from old.customer_id
            or new.chosen_at is distinct from old.chosen_at) then raise exception 'Freeze must retain consent'; end if;
        end if;
        if new.frozen_at is null and exists(select 1 from pick_session s join pick_line l on l.pick_session_id=s.id
          where s.order_operation_id=new.order_operation_id and l.shortage_recorded) then raise exception 'Existing shortage freezes preference'; end if;
        if exists(select 1 from pick_session where order_operation_id=new.order_operation_id and status='COMPLETED') then
          raise exception 'Completed picking preference is immutable'; end if;
        return new;
      end; $$;
      create trigger shortage_preference_guard before insert or update on order_shortage_preference
        for each row execute function gospaza_shortage_preference_guard();
      create function gospaza_shortage_guard() returns trigger language plpgsql as $$
      declare l pick_line; s pick_session; p order_shortage_preference; customer text;
      begin
        if TG_OP='UPDATE' then
          if old.status='RESOLVED_OMITTED' or old.invalidated_at is not null then raise exception 'Terminal shortage is immutable'; end if;
          if new.id<>old.id or new.order_operation_id<>old.order_operation_id or new.pick_session_id<>old.pick_session_id
            or new.pick_line_id<>old.pick_line_id or new.preference_id<>old.preference_id or new.evidence<>old.evidence
            or new.revision<>old.revision+1 then raise exception 'Shortage identity/evidence is immutable'; end if;
        elsif new.revision<>1 then raise exception 'Invalid shortage generation'; end if;
        select * into s from pick_session where id=new.pick_session_id;
        select * into l from pick_line where id=new.pick_line_id;
        select * into p from order_shortage_preference where id=new.preference_id;
        if s.status is distinct from 'IN_PROGRESS' or s.order_operation_id is distinct from new.order_operation_id
          or l.pick_session_id is distinct from s.id or p.order_operation_id is distinct from new.order_operation_id or p.frozen_at is null
          then raise exception 'Current authoritative picking required'; end if;
        select a.snapshot->>'customer_id' into customer from order_operation o
          join checkout_completion c on c.id=o.checkout_completion_id join checkout_attempt a on a.id=c.checkout_attempt_id
          join delivery_reservation r on r.id=a.reservation_id
          where o.id=new.order_operation_id and o.status='ACCEPTED' and c.state='SUCCEEDED' and c.native_state='done' and c.terminal_receipt is not null
            and c.order_id=o.medusa_order_id and a.state='COMPLETED' and r.status='COMMITTED' and r.medusa_order_id=o.medusa_order_id
            and o.medusa_order_id=new.evidence->>'native_order_id' and c.id=new.evidence->>'checkout_completion_id';
        if customer is null then raise exception 'Authoritative order required'; end if;
        if new.invalidated_at is null then
          if not l.shortage_recorded or l.picked_quantity>=l.ordered_quantity_at_start
            or l.picked_quantity<>(new.evidence->>'picked')::numeric or l.ordered_quantity_at_start<>(new.evidence->>'ordered')::numeric
            or l.medusa_order_line_id<>new.evidence->>'native_line_id' or s.source_lines_fingerprint<>new.evidence->>'source_lines_fingerprint'
            or p.preference<>new.evidence->>'preference' or p.revision<>(new.evidence->>'preference_revision')::integer
            then raise exception 'Stale shortage evidence'; end if;
        end if;
        if new.status='RESOLVED_OMITTED' then
          if p.preference='CONTACT_ME' and new.decision_customer_id is distinct from customer then raise exception 'Customer consent required'; end if;
          if p.preference='NO_SUBSTITUTION' and (p.customer_id is distinct from customer or new.decision_customer_id is not null) then
            raise exception 'Prior customer consent required'; end if;
        end if;
        return new;
      end; $$;
      create trigger shortage_guard before insert or update on shortage_resolution for each row execute function gospaza_shortage_guard();
      create function gospaza_omitted_line_guard() returns trigger language plpgsql as $$
      begin
        if (new.picked_quantity<>old.picked_quantity or new.shortage_recorded<>old.shortage_recorded)
          and exists(select 1 from shortage_resolution where pick_line_id=old.id and status='RESOLVED_OMITTED') then
          raise exception 'Omitted units cannot become picked'; end if;
        return new;
      end; $$;
      create trigger omitted_line_guard before update on pick_line for each row execute function gospaza_omitted_line_guard();
      create function gospaza_shortage_event_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP='UPDATE' then raise exception 'Shortage audit is append-only'; end if;
        if new.shortage_resolution_id is not null and not exists(select 1 from shortage_resolution
          where id=new.shortage_resolution_id and order_operation_id=new.order_operation_id) then raise exception 'Audit scope mismatch'; end if;
        return new;
      end; $$;
      create trigger shortage_event_guard before insert or update on shortage_event for each row execute function gospaza_shortage_event_guard();
      create function gospaza_shortage_audit_commit() returns trigger language plpgsql as $$
      declare required_action text;
      begin
        if TG_TABLE_NAME='order_shortage_preference' then
          if not exists(select 1 from order_shortage_preference where id=new.id) then return null; end if;
          required_action := case when new.frozen_at is not null then 'PREFERENCE_FROZEN'
            when TG_OP='INSERT' then 'PREFERENCE_CHOSEN' else 'PREFERENCE_CHANGED' end;
          if not exists(select 1 from shortage_event where order_operation_id=new.order_operation_id
            and action=required_action and (evidence->>'revision')::integer=new.revision) then
            raise exception 'Preference transition requires audit'; end if;
        else
          if not exists(select 1 from shortage_resolution where id=new.id) then return null; end if;
          required_action := case when new.invalidated_at is not null then 'SHORTAGE_INVALIDATED'
            when new.status='RESOLVED_OMITTED' then case when new.decision_customer_id is null
              then 'OMITTED_BY_PREFERENCE' else 'CUSTOMER_OMITTED' end else 'SHORTAGE_CREATED' end;
          if not exists(select 1 from shortage_event where shortage_resolution_id=new.id
            and action=required_action and (evidence->>'revision')::integer=new.revision) then
            raise exception 'Shortage transition requires audit'; end if;
        end if;
        return null;
      end; $$;
      create constraint trigger shortage_preference_audit after insert or update on order_shortage_preference
        deferrable initially deferred for each row execute function gospaza_shortage_audit_commit();
      create constraint trigger shortage_resolution_audit after insert or update on shortage_resolution
        deferrable initially deferred for each row execute function gospaza_shortage_audit_commit();
    `);
    this.addSql(`
      create or replace function gospaza_pick_commit_guard() returns trigger language plpgsql as $$
      declare s pick_session; e pick_event;
      begin
        select * into s from pick_session where id = new.id;
        if not found then return null; end if;
        select * into e from pick_event where pick_session_id = s.id and revision = new.revision;
        if not found then raise exception 'Picking transition requires audit'; end if;
        if TG_OP = 'INSERT' and (e.action <> 'CLAIM' or e.acting_member_id <> new.assigned_member_id) then
          raise exception 'Claim audit required'; end if;
        if TG_OP = 'UPDATE' then
          if new.assigned_member_id <> old.assigned_member_id and
            (e.action <> 'REASSIGN' or e."before"->>'assigned_member_id' is distinct from old.assigned_member_id
              or e."after"->>'assigned_member_id' is distinct from new.assigned_member_id) then
            raise exception 'Reassignment audit required'; end if;
          if new.status = 'COMPLETED' and e.action <> 'COMPLETE' then raise exception 'Completion audit required'; end if;
        end if;
        if not exists(select 1 from pick_line where pick_session_id = s.id) then raise exception 'Picking lines required'; end if;
        if s.status = 'COMPLETED' and exists(select 1 from pick_line l where l.pick_session_id = s.id
          and l.picked_quantity + coalesce((select (r.evidence->>'missing')::numeric from shortage_resolution r
            where r.pick_line_id=l.id and r.status='RESOLVED_OMITTED' and r.invalidated_at is null
              and (r.evidence->>'picked')::numeric=l.picked_quantity
              and (r.evidence->>'ordered')::numeric=l.ordered_quantity_at_start),0) <> l.ordered_quantity_at_start) then
          raise exception 'Unresolved picking cannot complete'; end if;
        return null;
      end; $$;
    `);
  }
}
