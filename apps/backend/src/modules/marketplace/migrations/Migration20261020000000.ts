import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20261020000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      do $$ declare c record; begin
        for c in select conname from pg_constraint where conrelid='delivery_operation'::regclass
          and contype='c' and pg_get_constraintdef(oid) like '%PENDING_DISPATCH%'
          and pg_get_constraintdef(oid) like '%generation%'
        loop execute format('alter table delivery_operation drop constraint %I', c.conname); end loop;
      end $$;
      alter table delivery_operation add constraint delivery_generation_state
        check((generation=0 and status in ('PENDING_DISPATCH','ATTENTION_REQUIRED'))
          or (generation=1 and status<>'PENDING_DISPATCH'));
      create table dispatch_work (
        delivery_id text primary key references delivery_operation(id),
        next_due_at timestamptz not null default now(),
        scan_offset integer not null default 0 check(scan_offset between 0 and 10000),
        observed_revision integer, last_error text
      );
      create index dispatch_work_due on dispatch_work(next_due_at,delivery_id);
      create table dispatch_repair_cursor (id text primary key, last_id text);
      insert into dispatch_repair_cursor(id) values ('completed-picking');
      insert into dispatch_work(delivery_id) select id from delivery_operation;
    `);
  }
  async down(): Promise<void> {
    this.addSql("drop table dispatch_work, dispatch_repair_cursor;");
    this.addSql(`alter table delivery_operation drop constraint delivery_generation_state;
      alter table delivery_operation add constraint delivery_generation_state
      check((status='PENDING_DISPATCH' and generation=0) or (status<>'PENDING_DISPATCH' and generation=1));`);
  }
}
