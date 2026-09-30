import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260930000000 extends Migration {
  async up(): Promise<void> {
    this.addSql('alter table merchant_store add constraint merchant_store_id_merchant_unique unique (id, merchant_id);');
    this.addSql(`create table cart_marketplace_context (
      id text primary key, medusa_cart_id text not null unique,
      merchant_id text not null references merchant(id) on delete restrict,
      merchant_store_id text not null, superseded_at timestamptz null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      deleted_at timestamptz null,
      constraint cart_context_store_merchant foreign key (merchant_store_id, merchant_id)
        references merchant_store(id, merchant_id) on delete restrict
    );`);
    this.addSql('create index cart_context_merchant on cart_marketplace_context (merchant_id);');
    this.addSql(`create function gospaza_immutable_cart_binding() returns trigger language plpgsql as $$ begin
      if new.medusa_cart_id is distinct from old.medusa_cart_id
        or new.merchant_id is distinct from old.merchant_id
        or new.merchant_store_id is distinct from old.merchant_store_id
        or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
        raise exception 'Cart binding cannot be changed or restored after supersession';
      end if;
      return new;
    end; $$;`);
    this.addSql('create trigger immutable_cart_binding before update on cart_marketplace_context for each row execute function gospaza_immutable_cart_binding();');
  }
  async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists(select 1 from cart_marketplace_context) then
        raise exception 'Cart bindings exist; explicit data migration required';
      end if;
    end $$;`);
    this.addSql('drop table cart_marketplace_context;');
    this.addSql('drop function gospaza_immutable_cart_binding();');
    this.addSql('alter table merchant_store drop constraint merchant_store_id_merchant_unique;');
  }
}
