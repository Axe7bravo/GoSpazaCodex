import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261004000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table cart_marketplace_context add constraint checkout_context_cart unique(id, medusa_cart_id);
      alter table delivery_reservation add constraint checkout_reservation_context unique(id, cart_context_id);
      create table checkout_attempt (
        id text primary key, cart_context_id text not null, medusa_cart_id text not null,
        reservation_id text not null, checkout_revision text not null, snapshot jsonb not null,
        state text not null default 'CONFIRMED' check(state in ('CONFIRMED','ABANDONED','EXPIRED')),
        expires_at timestamptz not null, closed_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
        foreign key(cart_context_id, medusa_cart_id) references cart_marketplace_context(id, medusa_cart_id),
        foreign key(reservation_id, cart_context_id) references delivery_reservation(id, cart_context_id),
        check((state = 'CONFIRMED') = (closed_at is null)), check(expires_at > created_at)
      );
      create unique index checkout_one_active_cart on checkout_attempt(medusa_cart_id) where closed_at is null;
      create unique index checkout_one_active_context on checkout_attempt(cart_context_id) where closed_at is null;
      create function gospaza_checkout_snapshot_immutable() returns trigger language plpgsql as $$ begin
        if old.id is distinct from new.id or old.created_at is distinct from new.created_at
          or old.snapshot is distinct from new.snapshot or old.checkout_revision is distinct from new.checkout_revision
          or old.cart_context_id is distinct from new.cart_context_id or old.medusa_cart_id is distinct from new.medusa_cart_id
          or old.reservation_id is distinct from new.reservation_id or old.expires_at is distinct from new.expires_at
          or old.closed_at is not null then
          raise exception 'Checkout snapshot is immutable';
        end if;
        return new;
      end; $$;
      create trigger checkout_snapshot_immutable before update on checkout_attempt
        for each row execute function gospaza_checkout_snapshot_immutable();
    `);
  }

  async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists(select 1 from checkout_attempt) then raise exception 'Checkout history exists; explicit data migration required'; end if;
    end $$;
    drop table checkout_attempt;
    drop function gospaza_checkout_snapshot_immutable();
    alter table delivery_reservation drop constraint checkout_reservation_context;
    alter table cart_marketplace_context drop constraint checkout_context_cart;
    `);
  }
}
