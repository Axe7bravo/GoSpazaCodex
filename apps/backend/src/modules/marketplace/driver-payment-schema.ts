// SQL-owned Finance records; no generic Medusa model/service CRUD registration.
export const driverPaymentSql = [
  `create table driver_payment (
    id text primary key, driver_profile_id text not null references driver_profile(id),
    payer text not null check(payer='GOSPAZA'), currency text not null check(currency='zar'),
    amount_minor bigint not null check(amount_minor between 1 and 9007199254740991),
    observed_amount_minor bigint not null check(observed_amount_minor=amount_minor),
    initial_outcome text not null check(initial_outcome in ('PAID','UNKNOWN')),
    beneficiary_reference text not null check(beneficiary_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
    channel text not null check(channel='BANK_TRANSFER'),
    origin_reference text not null check(origin_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
    external_transfer_id text not null check(external_transfer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
    transferred_at timestamptz not null, recorded_at timestamptz not null default clock_timestamp(),
    command_id text not null unique, policy_version text not null check(policy_version='M21_D_V1'),
    unique(channel,origin_reference,external_transfer_id))`,
  `create table driver_payment_command (
    id text primary key, payment_id text not null references driver_payment(id) deferrable initially deferred,
    actor_id text not null, request_id text not null, action text not null check(action in
      ('RECORD','UNKNOWN','CONFIRMED_PAID','CONFIRMED_NOT_PAID','RECONCILE','DISCREPANCY')),
    payload jsonb not null check(jsonb_typeof(payload)='object' and payload->>'confirmed'='true'
      and length(payload->>'reason') between 1 and 240 and payload->>'request_id'=request_id),
    recorded_at timestamptz not null default clock_timestamp(), unique(actor_id,request_id))`,
  `alter table driver_payment add constraint driver_payment_command_fk foreign key(command_id)
    references driver_payment_command(id) deferrable initially deferred`,
  `create table driver_payment_item (
    payment_id text not null references driver_payment(id), earning_id text not null references driver_earning(id),
    amount_minor bigint not null check(amount_minor>0), primary key(payment_id,earning_id))`,
  `create table driver_payment_resolution (
    payment_id text primary key references driver_payment(id),
    outcome text not null check(outcome in ('CONFIRMED_PAID','CONFIRMED_NOT_PAID')),
    command_id text not null unique references driver_payment_command(id))`,
  `create table driver_payment_hold (
    earning_id text primary key references driver_earning(id), payment_id text not null,
    foreign key(payment_id,earning_id) references driver_payment_item(payment_id,earning_id))`,
  `create table driver_payment_allocation (
    earning_id text primary key references driver_earning(id), payment_id text not null,
    driver_profile_id text not null references driver_profile(id), payer text not null check(payer='GOSPAZA'),
    currency text not null check(currency='zar'), amount_minor bigint not null check(amount_minor>0),
    command_id text not null references driver_payment_command(id),
    foreign key(payment_id,earning_id) references driver_payment_item(payment_id,earning_id))`,
  `create table driver_payment_reconciliation (
    payment_id text primary key references driver_payment(id), command_id text not null unique references driver_payment_command(id))`,
  `create table driver_payment_discrepancy (
    id text primary key, payment_id text not null references driver_payment(id),
    category text not null check(category in ('BENEFICIARY_MISMATCH','AMOUNT_MISMATCH','TRANSFER_DISPUTE',
      'DUPLICATE_EXTERNAL_RECORD','RETURNED_TRANSFER','RECONCILIATION_MISMATCH')),
    command_id text not null unique references driver_payment_command(id))`,
  `create index driver_payment_driver_idx on driver_payment(driver_profile_id,id)`,
  `create index driver_payment_item_earning_idx on driver_payment_item(earning_id)`,
  `create index driver_payment_discrepancy_payment_idx on driver_payment_discrepancy(payment_id)`,
  `create function gospaza_driver_payment_recording_time() returns trigger as $m21d$
    begin NEW.recorded_at:=clock_timestamp(); return NEW; end;
    $m21d$ language plpgsql`,
  `create trigger driver_payment_recording_time before insert on driver_payment
    for each row execute function gospaza_driver_payment_recording_time()`,
  `create trigger driver_payment_command_recording_time before insert on driver_payment_command
    for each row execute function gospaza_driver_payment_recording_time()`,
  `create function gospaza_driver_payment_admission() returns trigger as $m21d$
    declare action_name text; payload_row jsonb;
    begin
      perform 1 from driver_payment where id=NEW.payment_id for update;
      if TG_TABLE_NAME='driver_payment_item' then
        if exists(select 1 from driver_earning e join driver_earning_exception ex on ex.delivery_id=e.delivery_id where e.id=NEW.earning_id)
        then raise exception using errcode='23514',message='Driver earning attention blocks payment'; end if;
      elsif TG_TABLE_NAME in ('driver_payment_resolution','driver_payment_reconciliation') then
        if exists(select 1 from driver_payment_discrepancy ds where ds.payment_id=NEW.payment_id)
        then raise exception using errcode='23514',message='Driver payment discrepancy blocks action'; end if;
        if TG_TABLE_NAME='driver_payment_reconciliation' then action_name:='RECONCILE';
        else action_name:=NEW.outcome; end if;
        if action_name<>'CONFIRMED_NOT_PAID' and exists(select 1 from driver_payment_item pi
          join driver_earning e on e.id=pi.earning_id join driver_earning_exception ex on ex.delivery_id=e.delivery_id where pi.payment_id=NEW.payment_id)
        then raise exception using errcode='23514',message='Driver earning attention blocks payment'; end if;
      elsif TG_TABLE_NAME='driver_payment_command' then
        payload_row:=NEW.payload;
        if payload_row->>'confirmed' is distinct from 'true' or payload_row->>'request_id' is distinct from NEW.request_id
          or coalesce(length(payload_row->>'reason'),0) not between 1 and 240
        then raise exception using errcode='23514',message='Driver payment command evidence'; end if;
        if NEW.action in ('RECORD','UNKNOWN','RECONCILE') and
          (not (array(select jsonb_object_keys(payload_row)) @> array['earning_ids','amount_minor','currency','beneficiary_reference','transferred_at','channel','origin_reference','external_transfer_id'])
           or jsonb_typeof(payload_row->'earning_ids') is distinct from 'array'
           or payload_row->>'currency' is distinct from 'zar'
           or payload_row->>'channel' is distinct from 'BANK_TRANSFER'
           or coalesce(payload_row->>'amount_minor','') !~ '^[1-9][0-9]*$'
           or coalesce(payload_row->>'beneficiary_reference','') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
           or coalesce(payload_row->>'origin_reference','') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
           or coalesce(payload_row->>'external_transfer_id','') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
           or payload_row->>'transferred_at' is null)
        then raise exception using errcode='23514',message='Driver payment command facts'; end if;
      end if;
      return NEW;
    end;
    $m21d$ language plpgsql`,
  ...["driver_payment_item", "driver_payment_resolution", "driver_payment_reconciliation", "driver_payment_discrepancy", "driver_payment_command"].map(table =>
    `create trigger ${table}_admission before insert on ${table} for each row execute function gospaza_driver_payment_admission()`),
  `create function gospaza_driver_payment_immutable() returns trigger as $m21d$
    begin raise exception using errcode='23514',message='Immutable driver payment history'; end;
    $m21d$ language plpgsql`,
  ...["driver_payment", "driver_payment_command", "driver_payment_item", "driver_payment_resolution", "driver_payment_allocation",
    "driver_payment_reconciliation", "driver_payment_discrepancy"].map(table =>
    `create trigger ${table}_immutable before update or delete on ${table} for each row execute function gospaza_driver_payment_immutable()`),
  `create function gospaza_driver_payment_hold_guard() returns trigger as $m21d$
    begin
      if TG_OP='UPDATE' then raise exception using errcode='23514',message='Immutable driver payment reservation'; end if;
      if TG_OP='DELETE' then
        if not exists(select 1 from driver_payment_resolution pr where pr.payment_id=OLD.payment_id and pr.outcome='CONFIRMED_NOT_PAID')
          or exists(select 1 from driver_payment_allocation pa where pa.earning_id=OLD.earning_id)
        then raise exception using errcode='23514',message='Unproven driver nonpayment'; end if;
        return OLD;
      end if;
      if exists(select 1 from driver_payment_allocation pa where pa.earning_id=NEW.earning_id)
      then raise exception using errcode='23514',message='Driver earning already allocated'; end if;
      return NEW;
    end;
    $m21d$ language plpgsql`,
  `create trigger driver_payment_hold_guard before insert or update or delete on driver_payment_hold
    for each row execute function gospaza_driver_payment_hold_guard()`,
  `create function gospaza_driver_payment_consistent(target text) returns void as $m21d$
    declare payment_row driver_payment%rowtype; command_row driver_payment_command%rowtype;
      resolution_row driver_payment_resolution%rowtype; item_count integer; item_total numeric; is_paid boolean; is_released boolean;
    begin
      select * into payment_row from driver_payment where id=target;
      if not found then raise exception using errcode='23514',message='Driver payment missing'; end if;
      select * into command_row from driver_payment_command where id=payment_row.command_id;
      if not found or command_row.payment_id<>target or command_row.action<>(case when payment_row.initial_outcome='PAID' then 'RECORD' else 'UNKNOWN' end)
        or command_row.payload->>'currency'<>payment_row.currency
        or (command_row.payload->>'amount_minor')::numeric<>payment_row.amount_minor
        or command_row.payload->>'beneficiary_reference'<>payment_row.beneficiary_reference
        or command_row.payload->>'channel'<>payment_row.channel
        or command_row.payload->>'origin_reference'<>payment_row.origin_reference
        or command_row.payload->>'external_transfer_id'<>payment_row.external_transfer_id
        or (command_row.payload->>'transferred_at')::timestamptz<>payment_row.transferred_at
        or coalesce(length(command_row.payload->>'evidence_reference'),0)=0
      then raise exception using errcode='23514',message='Driver payment recording audit'; end if;
      select count(*),coalesce(sum(pi.amount_minor),0) into item_count,item_total from driver_payment_item pi where pi.payment_id=target;
      if item_count not between 1 and 100 or item_total<>payment_row.amount_minor
        or command_row.payload->'earning_ids' is distinct from
          (select jsonb_agg(pi.earning_id order by pi.earning_id collate "C") from driver_payment_item pi where pi.payment_id=target)
        or payment_row.transferred_at>payment_row.recorded_at
        or exists(select 1 from driver_payment_item pi join driver_earning e on e.id=pi.earning_id where pi.payment_id=target and
          (pi.amount_minor<>e.amount_minor or e.driver_profile_id<>payment_row.driver_profile_id or e.payer<>payment_row.payer
           or e.currency<>payment_row.currency or payment_row.transferred_at<greatest(e.economic_at,e.recorded_at)))
      then raise exception using errcode='23514',message='Driver payment whole earning manifest'; end if;
      select * into resolution_row from driver_payment_resolution where payment_id=target;
      if found then
        select * into command_row from driver_payment_command where id=resolution_row.command_id;
        if payment_row.initial_outcome<>'UNKNOWN' or command_row.payment_id<>target or command_row.action<>resolution_row.outcome
          or coalesce(length(command_row.payload->>'review_reference'),0)=0 or coalesce(length(command_row.payload->>'evidence_reference'),0)=0
          or (resolution_row.outcome='CONFIRMED_NOT_PAID' and
            (command_row.payload->>'nonreceipt_confirmed' is distinct from 'true'
             or coalesce(command_row.payload->>'failure_category','') not in ('BANK_REJECTED','RETURNED_BEFORE_RECEIPT','RAIL_CONFIRMED_FAILURE')))
        then raise exception using errcode='23514',message='Driver payment resolution audit'; end if;
      end if;
      is_paid:=payment_row.initial_outcome='PAID' or coalesce(resolution_row.outcome='CONFIRMED_PAID',false);
      is_released:=coalesce(resolution_row.outcome='CONFIRMED_NOT_PAID',false);
      if exists(select 1 from driver_payment_item pi where pi.payment_id=target and
          (exists(select 1 from driver_payment_hold ph where ph.payment_id=target and ph.earning_id=pi.earning_id)=is_released))
        or exists(select 1 from driver_payment_allocation pa where pa.payment_id=target and
          (not is_paid or pa.driver_profile_id<>payment_row.driver_profile_id or pa.payer<>payment_row.payer
           or pa.currency<>payment_row.currency or pa.amount_minor<>(select pi.amount_minor from driver_payment_item pi where pi.payment_id=target and pi.earning_id=pa.earning_id)
           or pa.command_id<>coalesce(resolution_row.command_id,payment_row.command_id)))
        or (is_paid and item_count<>(select count(*) from driver_payment_allocation pa where pa.payment_id=target))
      then raise exception using errcode='23514',message='Driver payment allocation reservation consistency'; end if;
      -- Every command is itself append-only transition/audit evidence. No orphan action can commit.
      if exists(select 1 from driver_payment_command pc where pc.payment_id=target and not coalesce((
        (pc.id=payment_row.command_id and pc.action in ('RECORD','UNKNOWN')) or
        (pc.id=resolution_row.command_id and pc.action=resolution_row.outcome) or
        (pc.action='RECONCILE' and exists(select 1 from driver_payment_reconciliation rc where rc.payment_id=target and rc.command_id=pc.id)) or
        (pc.action='DISCREPANCY' and exists(select 1 from driver_payment_discrepancy ds where ds.payment_id=target and ds.command_id=pc.id and ds.category=pc.payload->>'category'))
      ),false)) then raise exception using errcode='23514',message='Driver payment action audit'; end if;
      if exists(select 1 from driver_payment_reconciliation rc join driver_payment_command pc on pc.id=rc.command_id where rc.payment_id=target and
        (not is_paid or pc.payment_id<>target or pc.action<>'RECONCILE'
         or pc.payload->>'driver_profile_id' is distinct from payment_row.driver_profile_id
         or (pc.payload->>'amount_minor')::numeric<>payment_row.amount_minor or pc.payload->>'currency'<>payment_row.currency
         or pc.payload->>'beneficiary_reference'<>payment_row.beneficiary_reference
         or pc.payload->>'channel'<>payment_row.channel or pc.payload->>'origin_reference'<>payment_row.origin_reference
         or pc.payload->>'external_transfer_id'<>payment_row.external_transfer_id
         or (pc.payload->>'transferred_at')::timestamptz<>payment_row.transferred_at
         or coalesce(length(pc.payload->>'review_reference'),0)=0
         or pc.payload->'earning_ids' is distinct from (select jsonb_agg(pi.earning_id order by pi.earning_id collate "C") from driver_payment_item pi where pi.payment_id=target)))
      then raise exception using errcode='23514',message='Driver payment reconciliation audit'; end if;
      if exists(select 1 from driver_payment_discrepancy ds join driver_payment_command pc on pc.id=ds.command_id where ds.payment_id=target and
        (pc.payment_id<>target or pc.action<>'DISCREPANCY' or pc.payload->>'category' is distinct from ds.category
         or coalesce(length(pc.payload->>'evidence_reference'),0)=0))
      then raise exception using errcode='23514',message='Driver payment discrepancy audit'; end if;
    end;
    $m21d$ language plpgsql`,
  `create function gospaza_driver_payment_deferred() returns trigger as $m21d$
    begin
      if TG_TABLE_NAME='driver_payment' then perform gospaza_driver_payment_consistent(NEW.id);
      elsif TG_OP='DELETE' then perform gospaza_driver_payment_consistent(OLD.payment_id);
      else perform gospaza_driver_payment_consistent(NEW.payment_id); end if;
      return null;
    end;
    $m21d$ language plpgsql`,
  ...["driver_payment", "driver_payment_command", "driver_payment_item", "driver_payment_resolution", "driver_payment_hold", "driver_payment_allocation",
    "driver_payment_reconciliation", "driver_payment_discrepancy"].map(table =>
    `create constraint trigger ${table}_consistent after insert or update or delete on ${table}
      deferrable initially deferred for each row execute function gospaza_driver_payment_deferred()`),
];
