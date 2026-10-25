import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261024100000 extends Migration {
  async up(): Promise<void> {
    // Keep the already-applied migration and all deferred trigger attachments.
    // A SQL CASE still resolves both record-field references when prepared.
    // Separate PL/pgSQL statements only access fields of their actual row type.
    this.addSql(`
      create or replace function gospaza_handoff_consistency() returns trigger language plpgsql as $$
      declare target text; d delivery_operation; c dispatch_commitment; op delivery_completion; begin
        if TG_TABLE_NAME='delivery_operation' then
          target:=new.id;
        elsif TG_TABLE_NAME='delivery_completion' then
          target:=new.delivery_id;
        elsif TG_TABLE_NAME='dispatch_commitment' then
          target:=new.delivery_id;
        else
          raise exception 'Unsupported handoff consistency trigger table: %', TG_TABLE_NAME;
        end if;
        select * into d from delivery_operation where id=target;
        select * into op from delivery_completion where delivery_id=target;
        if op.id is not null then
          select * into c from dispatch_commitment where id=op.commitment_id;
          if c.delivery_id is distinct from target or c.status not in ('ASSIGNED','COMPLETED') or not exists
            (select 1 from handoff_generation g where g.id=op.generation_id and g.delivery_id=target and g.state='CONSUMED')
            or not exists(select 1 from pickup_operation p where p.id=op.ship_operation_id and p.delivery_id=target and p.action='SHIP' and p.state='SUCCEEDED')
            then raise exception 'Completion authority mismatch'; end if;
        end if;
        if d.status='DELIVERED' or exists(select 1 from dispatch_commitment where delivery_id=target and status='COMPLETED') then
          if d.status<>'DELIVERED' or d.delivered_at is null or d.arrived_at is null or op.id is null or op.state<>'SUCCEEDED'
            or c.status<>'COMPLETED' or op.receipt->>'fulfillment_id' is distinct from d.native_fulfillment_id
            or exists(select 1 from dispatch_commitment where delivery_id=target and status in ('ASSIGNED','OFFERED'))
            or not exists(select 1 from dispatch_event where target_id=target and action='DELIVERED' and revision=d.revision)
            then raise exception 'Delivery completion receipt required'; end if;
        end if;
        return null;
      end $$;
    `);
  }

  async down(): Promise<void> {
    throw new Error("Do not restore the invalid handoff trigger; use a forward corrective migration.");
  }
}
