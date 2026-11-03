import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20261031120300 extends Migration {
  async up():Promise<void> {
    this.addSql(`create table omission_reservation_release (
      resolution_id text primary key references shortage_resolution(id), order_id text not null,
      line_id text not null, location_id text not null, missing_quantity integer not null check(missing_quantity>0),
      reservations jsonb not null check(jsonb_typeof(reservations)='array'),
      status text not null check(status in ('DISPATCHED','COMPLETED','ATTENTION_REQUIRED')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );`);
    this.addSql(`create function gospaza_omission_release_guard() returns trigger as $omit$
      begin
        if TG_OP='DELETE' or (TG_OP='UPDATE' and (OLD.status<>'DISPATCHED' or NEW.status='DISPATCHED'
          or (to_jsonb(OLD)-array['status','updated_at']) is distinct from (to_jsonb(NEW)-array['status','updated_at'])))
          then raise exception 'Omission release immutable'; end if;
        if not exists(select 1 from shortage_resolution s where s.id=NEW.resolution_id and s.status='RESOLVED_OMITTED'
          and s.financial_review_required and s.invalidated_at is null and s.deleted_at is null
          and s.evidence->>'native_line_id'=NEW.line_id and s.evidence->>'native_order_id'=NEW.order_id
          and (s.evidence->>'missing')::integer=NEW.missing_quantity)
          then raise exception 'Omission release source'; end if;
        return NEW;
      end;
      $omit$ language plpgsql;`);
    this.addSql(`create trigger omission_release_guard before insert or update or delete on omission_reservation_release
      for each row execute function gospaza_omission_release_guard();`);
  }
  async down(): Promise<void> { throw new Error("Inventory history requires a forward migration."); }
}
