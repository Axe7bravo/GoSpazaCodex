import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261012000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table pick_session (
        id text primary key,
        order_operation_id text not null unique references order_operation(id) on delete restrict,
        assigned_member_id text not null references merchant_member(id) on delete restrict,
        status text not null default 'IN_PROGRESS' check(status in ('IN_PROGRESS','COMPLETED')),
        revision integer not null default 1 check(revision > 0),
        source_lines_fingerprint text not null check(source_lines_fingerprint ~ '^[a-f0-9]{64}$'),
        started_at timestamptz not null, completed_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz check(deleted_at is null),
        check((status = 'IN_PROGRESS' and completed_at is null) or (status = 'COMPLETED' and completed_at is not null and completed_at >= started_at))
      );
      create table pick_line (
        id text primary key,
        pick_session_id text not null references pick_session(id) on delete restrict,
        medusa_order_line_id text not null,
        ordered_quantity_at_start numeric not null,
        raw_ordered_quantity_at_start jsonb not null,
        picked_quantity numeric not null default 0,
        raw_picked_quantity jsonb not null,
        shortage_recorded boolean not null default false,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz check(deleted_at is null),
        unique(pick_session_id, medusa_order_line_id),
        check(ordered_quantity_at_start between 1 and 9007199254740991 and ordered_quantity_at_start = trunc(ordered_quantity_at_start)),
        check(picked_quantity between 0 and ordered_quantity_at_start and picked_quantity = trunc(picked_quantity)),
        check(not shortage_recorded or picked_quantity < ordered_quantity_at_start),
        check(raw_ordered_quantity_at_start->>'value' is not null and (raw_ordered_quantity_at_start->>'value')::numeric = ordered_quantity_at_start),
        check(raw_picked_quantity->>'value' is not null and (raw_picked_quantity->>'value')::numeric = picked_quantity)
      );
      create table pick_event (
        id text primary key,
        pick_session_id text not null references pick_session(id) on delete restrict,
        revision integer not null, previous_revision integer not null,
        action text not null check(action in ('CLAIM','LINE','REASSIGN','COMPLETE')),
        acting_member_id text not null references merchant_member(id) on delete restrict,
        medusa_order_line_id text,
        request jsonb not null, "before" jsonb not null, "after" jsonb not null,
        occurred_at timestamptz not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz check(deleted_at is null),
        unique(pick_session_id, revision),
        check(previous_revision >= 0 and revision = previous_revision + 1),
        check((action = 'CLAIM') = (previous_revision = 0)),
        check((action = 'LINE') = (medusa_order_line_id is not null)),
        check(jsonb_typeof(request) = 'object' and jsonb_typeof("before") = 'object' and jsonb_typeof("after") = 'object')
      );
      create function gospaza_pick_session_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP = 'UPDATE' then
          if old.status = 'COMPLETED' then raise exception 'Completed picking is immutable'; end if;
          if new.id <> old.id or new.order_operation_id <> old.order_operation_id
            or new.started_at <> old.started_at or new.source_lines_fingerprint <> old.source_lines_fingerprint
            or new.revision <> old.revision + 1 then raise exception 'Picking identity/revision is immutable'; end if;
        elsif new.status <> 'IN_PROGRESS' or new.revision <> 1 then
          raise exception 'Picking must begin in progress';
        end if;
        if not exists (
          select 1 from order_operation o join checkout_completion c on c.id = o.checkout_completion_id
          join checkout_attempt a on a.id = c.checkout_attempt_id
          join delivery_reservation r on r.id = a.reservation_id
          join merchant_member m on m.id = new.assigned_member_id
          where o.id = new.order_operation_id and o.status = 'ACCEPTED' and o.deleted_at is null
            and c.state = 'SUCCEEDED' and c.native_state = 'done' and c.terminal_receipt is not null
            and c.order_id = o.medusa_order_id and a.state = 'COMPLETED'
            and r.status = 'COMMITTED' and r.medusa_order_id = o.medusa_order_id
            and m.merchant_id = o.merchant_id and m.status = 'ACTIVE' and m.deleted_at is null
            and m.member_type in ('OWNER','MANAGER','PICKER')
        ) then raise exception 'Accepted authoritative order and active assignee required'; end if;
        return new;
      end; $$;
      create trigger pick_session_guard before insert or update on pick_session
        for each row execute function gospaza_pick_session_guard();
      create function gospaza_pick_line_guard() returns trigger language plpgsql as $$
      declare s pick_session;
      begin
        select * into s from pick_session where id = new.pick_session_id;
        if s.status <> 'IN_PROGRESS' then raise exception 'Completed picking lines are immutable'; end if;
        if TG_OP = 'INSERT' then
          if s.revision <> 1 or new.picked_quantity <> 0 or new.shortage_recorded then
            raise exception 'Lines must be created with claim'; end if;
        elsif new.id <> old.id or new.pick_session_id <> old.pick_session_id
          or new.medusa_order_line_id <> old.medusa_order_line_id
          or new.ordered_quantity_at_start <> old.ordered_quantity_at_start then
          raise exception 'Picking line identity is immutable';
        end if;
        return new;
      end; $$;
      create trigger pick_line_guard before insert or update on pick_line
        for each row execute function gospaza_pick_line_guard();
      create function gospaza_pick_event_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP = 'UPDATE' then raise exception 'Picking audit is append-only'; end if;
        if not exists (select 1 from pick_session s join order_operation o on o.id = s.order_operation_id
          join merchant_member m on m.id = new.acting_member_id
          where s.id = new.pick_session_id and s.revision = new.revision
            and m.merchant_id = o.merchant_id and m.status = 'ACTIVE' and m.deleted_at is null
            and ((new.action = 'REASSIGN' and m.member_type in ('OWNER','MANAGER'))
              or (new.action <> 'REASSIGN' and m.id = s.assigned_member_id))
            and (new.action <> 'COMPLETE' or (s.status = 'COMPLETED' and s.completed_at = new.occurred_at)))
        then raise exception 'Picking audit must match its authorized transition'; end if;
        return new;
      end; $$;
      create trigger pick_event_guard before insert or update on pick_event
        for each row execute function gospaza_pick_event_guard();
      create function gospaza_pick_commit_guard() returns trigger language plpgsql as $$
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
        if s.status = 'COMPLETED' and exists(select 1 from pick_line where pick_session_id = s.id
          and (picked_quantity <> ordered_quantity_at_start or shortage_recorded)) then
          raise exception 'Unresolved picking cannot complete'; end if;
        return null;
      end; $$;
      create constraint trigger pick_commit_guard after insert or update on pick_session
        deferrable initially deferred for each row execute function gospaza_pick_commit_guard();
      create function gospaza_pick_line_audit_guard() returns trigger language plpgsql as $$
      begin
        if not exists(select 1 from pick_event e join pick_session s on s.id = e.pick_session_id
          where s.id = new.pick_session_id and e.revision = s.revision and e.action = 'LINE'
            and e.medusa_order_line_id = new.medusa_order_line_id
            and (e."after"->>'picked_quantity')::numeric = new.picked_quantity
            and (e."after"->>'shortage_recorded')::boolean = new.shortage_recorded) then
          raise exception 'Line update requires matching audit'; end if;
        return null;
      end; $$;
      create constraint trigger pick_line_audit_guard after update on pick_line
        deferrable initially deferred for each row execute function gospaza_pick_line_audit_guard();
    `);
  }
  async down(): Promise<void> {
    throw new Error("Picking history requires an explicit forward migration.");
  }
}
