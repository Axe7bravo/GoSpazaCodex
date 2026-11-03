import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20261031120100 extends Migration {
  async up(): Promise<void> {
    this.addSql(`create table returned_inventory_disposition (
      id text primary key, return_id text not null references restricted_return(id), order_id text not null,
      fulfillment_id text not null, line_id text not null, quantity integer not null check(quantity>0),
      store_id text not null, actor_member_id text not null, decision text not null check(decision in ('RESTOCK','NON_SELLABLE')),
      status text not null check(status in ('DISPATCHED','COMPLETED','ATTENTION_REQUIRED')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique(fulfillment_id,line_id), unique(return_id,line_id)
    );`);
    this.addSql(`create function gospaza_disposition_guard() returns trigger as $disp$
      begin
        if TG_OP='DELETE' then raise exception 'Disposition history immutable'; end if;
        if TG_OP='UPDATE' and (OLD.status<>'DISPATCHED' or NEW.status not in ('COMPLETED','ATTENTION_REQUIRED')
          or (to_jsonb(OLD)-array['status','updated_at']) is distinct from (to_jsonb(NEW)-array['status','updated_at']))
          then raise exception 'Disposition immutable'; end if;
        if not exists(select 1 from restricted_return r join delivery_operation d on d.id=r.delivery_id
          cross join lateral jsonb_array_elements(r.physical_manifest) item
          where r.id=NEW.return_id and r.state='RETURNED_TO_STORE' and r.received_by is not null
            and r.returned_at is not null and r.merchant_store_id=NEW.store_id and r.fulfillment_id=NEW.fulfillment_id
            and d.medusa_order_id=NEW.order_id and item->>'id'=NEW.line_id and (item->>'quantity')::integer=NEW.quantity)
          then raise exception 'Disposition requires physical receipt'; end if;
        return NEW;
      end;
      $disp$ language plpgsql;`);
    this.addSql(`create trigger disposition_guard before insert or update or delete on returned_inventory_disposition
      for each row execute function gospaza_disposition_guard();`);
    this.addSql(`create table returned_inventory_event (
      disposition_id text not null references returned_inventory_disposition(id), status text not null,
      occurred_at timestamptz not null default now(), primary key(disposition_id,status)
    );`);
    this.addSql(`create trigger disposition_event_immutable before update or delete on returned_inventory_event
      for each row execute function gospaza_refund_audit_guard();`);
    this.addSql(`create function gospaza_disposition_audit() returns trigger as $disp$
      begin
        insert into returned_inventory_event(disposition_id,status) values(NEW.id,NEW.status);
        return NEW;
      end;
      $disp$ language plpgsql;`);
    this.addSql(`create trigger disposition_audit after insert or update on returned_inventory_disposition
      for each row execute function gospaza_disposition_audit();`);
  }
  async down(): Promise<void> { throw new Error("Disposition history requires a forward migration."); }
}
