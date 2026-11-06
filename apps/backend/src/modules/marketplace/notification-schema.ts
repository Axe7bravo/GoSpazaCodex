// Notification-owned SQL lives in the existing module's migration stream; no
// MedusaService CRUD models are registered for these append-only records.
export const notificationSql = [
  `create table notification_activation (
    id text primary key check(length(id) between 1 and 128), revision integer not null unique check(revision=1),
    activated_at timestamptz not null, recorded_at timestamptz not null default clock_timestamp(),
    actor_id text not null check(length(actor_id) between 1 and 128), reason text not null check(length(reason) between 1 and 240),
    request_id text not null unique check(length(request_id) between 1 and 128), fingerprint text not null check(length(fingerprint)=64),
    check(activated_at>=recorded_at))`,
  `create table notification_intent (
    id text primary key check(length(id) between 1 and 128), logical_key text not null unique check(length(logical_key)=64), request_fingerprint text not null check(length(request_fingerprint)=64),
    source_type text not null check(length(source_type) between 1 and 128), source_id text not null check(length(source_id) between 1 and 128),
    source_transition text not null check(length(source_transition) between 1 and 128), source_committed_at timestamptz not null,
    source_evidence text not null check(length(source_evidence) between 1 and 128), kind text not null check(length(kind) between 1 and 128),
    recipient_type text not null check(recipient_type in ('customer','merchant','driver','user','guest')),
    recipient_id text not null check(length(recipient_id) between 1 and 128), channel text not null check(channel in ('IN_APP','EMAIL')),
    destination text check(length(destination) between 3 and 254 and destination !~ E'[\\r\\n]'),
    template_key text not null check(length(template_key) between 1 and 80), template_version integer not null check(template_version>0),
    title text not null check(length(title) between 1 and 160), subject text not null check(length(subject) between 1 and 200 and subject !~ E'[\\r\\n]'),
    body text not null check(length(body) between 1 and 8000), html text not null check(length(html) between 1 and 24000),
    deep_link text check(length(deep_link)<=240 and deep_link ~ '^/orders/[A-Za-z0-9_.:%-]+$'),
    envelope jsonb, envelope_hash text check(length(envelope_hash)=64), provider_key text unique check(length(provider_key) between 1 and 256),
    credential_fingerprint text check(length(credential_fingerprint)=64),
    activation_id text not null references notification_activation(id), created_at timestamptz not null default clock_timestamp(),
    unique(source_type,source_id,source_transition,kind,recipient_type,recipient_id,channel),
    check(channel='EMAIL' or (destination is null and envelope is null and envelope_hash is null and provider_key is null and recipient_type<>'guest')),
    check(channel<>'EMAIL' or provider_key is not null),
    check((envelope is null)=(envelope_hash is null)),
    check((envelope is null)=(credential_fingerprint is null)),
    check(envelope is null or (channel='EMAIL' and destination is not null and jsonb_typeof(envelope)='object'
      and octet_length(envelope::text)<=50000 and envelope->>'to'=destination
      and (envelope-array['from','to','subject','text','html','reply_to'])='{}'::jsonb)))`,
  `create table notification_delivery (
    intent_id text primary key references notification_intent(id), revision integer not null check(revision>0),
    state text not null check(state in ('PENDING','IN_PROGRESS','ACCEPTED','RETRYABLE_FAILURE','TERMINAL_FAILURE','ATTENTION_REQUIRED','SUPPRESSED')),
    suppression_reason text check(suppression_reason in ('NO_RECIPIENT','STALE','POLICY','AUTHORIZATION_CHANGED')),
    attempts integer not null default 0 check(attempts between 0 and 4), claim_token text, lease_until timestamptz,
    first_sent_at timestamptz, next_attempt_at timestamptz, accepted_at timestamptz,
    check((state='SUPPRESSED')=(suppression_reason is not null)),
    check((state='IN_PROGRESS')=(claim_token is not null and lease_until is not null)),
    check((state='RETRYABLE_FAILURE')=(next_attempt_at is not null)), check((state='ACCEPTED')=(accepted_at is not null)))`,
  `create table notification_delivery_event (
    intent_id text not null references notification_intent(id), revision integer not null, from_state text, to_state text not null,
    code text not null check(code ~ '^[A-Z_]{1,60}$'), occurred_at timestamptz not null default clock_timestamp(), primary key(intent_id,revision))`,
  `create table notification_notice (
    intent_id text primary key references notification_intent(id), created_at timestamptz not null default clock_timestamp(), read_at timestamptz)`,
  `create table notification_attempt (
    id text primary key check(length(id) between 1 and 128), intent_id text not null references notification_intent(id), attempt_number integer not null check(attempt_number between 1 and 4),
    provider text not null check(provider='RESEND'), provider_key text not null check(length(provider_key) between 1 and 256),
    envelope_hash text not null check(length(envelope_hash)=64), claim_token text not null unique,
    credential_fingerprint text not null check(length(credential_fingerprint)=64),
    started_at timestamptz not null default clock_timestamp(), lease_until timestamptz not null,
    unique(intent_id,attempt_number), check(lease_until>started_at))`,
  `create table notification_attempt_started (
    attempt_id text primary key references notification_attempt(id), dispatched_at timestamptz not null default clock_timestamp())`,
  `create table notification_provider_message (
    provider_id text primary key check(length(provider_id) between 1 and 128 and provider_id ~ '^[A-Za-z0-9_-]+$'),
    intent_id text not null unique references notification_intent(id), recorded_at timestamptz not null default clock_timestamp())`,
  `create table notification_attempt_result (
    attempt_id text primary key references notification_attempt(id),
    classification text not null check(classification in ('ACCEPTED','RETRYABLE','TERMINAL','AMBIGUOUS')),
    code text not null check(code ~ '^[A-Z_]{1,60}$'), summary text not null check(length(summary)<=120),
    provider_id text references notification_provider_message(provider_id), native_id text check(length(native_id) between 1 and 128),
    completed_at timestamptz not null default clock_timestamp(), check((classification='ACCEPTED')=(provider_id is not null)))`,
  `create table notification_provider_evidence (
    event_id text primary key check(length(event_id) between 1 and 128), provider_id text not null references notification_provider_message(provider_id),
    attempt_id text not null references notification_attempt(id), event_type text not null check(event_type in ('sent','delivered','delivery_delayed','bounced','complained','failed')),
    occurred_at timestamptz not null, received_at timestamptz not null default clock_timestamp(), fingerprint text not null check(length(fingerprint)=64))`,
  `create index notification_delivery_due on notification_delivery(state,next_attempt_at)`,
  `create index notification_recipient on notification_intent(recipient_type,recipient_id,created_at,id)`,
  `create function gospaza_notification_immutable() returns trigger as $gospaza$
   begin raise exception 'Immutable notification evidence' using errcode='23514'; end;
   $gospaza$ language plpgsql`,
  ...["notification_activation", "notification_intent", "notification_delivery_event", "notification_attempt", "notification_attempt_started",
    "notification_attempt_result", "notification_provider_message", "notification_provider_evidence"].map(table =>
    `create trigger ${table}_immutable before update or delete on ${table} for each row execute function gospaza_notification_immutable()`),
  `create function gospaza_notification_admission() returns trigger as $gospaza$
   begin
    if not exists(select 1 from notification_activation a where a.id=NEW.activation_id and a.activated_at<=NEW.source_committed_at)
       or NEW.source_committed_at>clock_timestamp() then raise exception 'Notification activation boundary' using errcode='23514'; end if;
    if NEW.envelope is not null and ((NEW.envelope->>'subject') is distinct from NEW.subject
      or (NEW.envelope->>'text') is distinct from NEW.body or (NEW.envelope->>'html') is distinct from NEW.html) then
      raise exception 'Notification frozen envelope mismatch' using errcode='23514'; end if;
    return NEW;
   end;
   $gospaza$ language plpgsql`,
  `create trigger notification_admission before insert on notification_intent for each row execute function gospaza_notification_admission()`,
  `create function gospaza_notification_delivery_guard() returns trigger as $gospaza$
   begin
    if TG_OP='DELETE' then raise exception 'Notification history cannot be deleted' using errcode='23514'; end if;
    if TG_OP='UPDATE' then
     if NEW.intent_id<>OLD.intent_id or NEW.revision<>OLD.revision+1 or NEW.attempts<OLD.attempts or NEW.attempts>OLD.attempts+1
       or (OLD.first_sent_at is not null and NEW.first_sent_at is distinct from OLD.first_sent_at)
       or not exists(select 1 from notification_delivery_event e where e.intent_id=NEW.intent_id and e.revision=NEW.revision and e.from_state=OLD.state and e.to_state=NEW.state)
       or not ((OLD.state in ('PENDING','RETRYABLE_FAILURE') and NEW.state in ('IN_PROGRESS','SUPPRESSED','ATTENTION_REQUIRED'))
          or (OLD.state='IN_PROGRESS' and NEW.state in ('IN_PROGRESS','ACCEPTED','RETRYABLE_FAILURE','TERMINAL_FAILURE','ATTENTION_REQUIRED')))
     then raise exception 'Unproven notification transition' using errcode='23514'; end if;
    elsif NEW.revision<>1 or NEW.attempts<>0 or NEW.state not in ('PENDING','ACCEPTED','SUPPRESSED','ATTENTION_REQUIRED') then
     raise exception 'Invalid notification initial state' using errcode='23514';
    end if;
    return NEW;
   end;
   $gospaza$ language plpgsql`,
  `create trigger notification_delivery_guard before insert or update or delete on notification_delivery for each row execute function gospaza_notification_delivery_guard()`,
  `create function gospaza_notification_notice_guard() returns trigger as $gospaza$
   begin
    if TG_OP='DELETE' then raise exception 'Notification notice cannot be deleted' using errcode='23514'; end if;
    if TG_OP='UPDATE' and (NEW.intent_id<>OLD.intent_id or NEW.created_at<>OLD.created_at or OLD.read_at is not null or NEW.read_at is null) then
      raise exception 'Notification read state only' using errcode='23514'; end if;
    if not exists(select 1 from notification_intent i where i.id=NEW.intent_id and i.channel='IN_APP') then
      raise exception 'Notification notice channel mismatch' using errcode='23514'; end if;
    return NEW;
   end;
   $gospaza$ language plpgsql`,
  `create trigger notification_notice_guard before insert or update or delete on notification_notice for each row execute function gospaza_notification_notice_guard()`,
  `create function gospaza_notification_attempt_guard() returns trigger as $gospaza$
   declare delivery_row notification_delivery%rowtype;
   begin
    select * into delivery_row from notification_delivery where intent_id=NEW.intent_id for update;
    if not found or delivery_row.state not in ('PENDING','RETRYABLE_FAILURE') or NEW.attempt_number<>delivery_row.attempts+1
       or (delivery_row.next_attempt_at is not null and delivery_row.next_attempt_at>clock_timestamp())
       or (delivery_row.first_sent_at is not null and clock_timestamp()>=delivery_row.first_sent_at+interval '23 hours')
       or not exists(select 1 from notification_intent i where i.id=NEW.intent_id and i.channel='EMAIL' and i.envelope is not null and i.provider_key=NEW.provider_key and i.envelope_hash=NEW.envelope_hash and i.credential_fingerprint=NEW.credential_fingerprint)
    then raise exception 'Notification send admission conflict' using errcode='23514'; end if;
    return NEW;
   end;
   $gospaza$ language plpgsql`,
  `create trigger notification_attempt_guard before insert on notification_attempt for each row execute function gospaza_notification_attempt_guard()`,
  `create function gospaza_notification_started_guard() returns trigger as $gospaza$
   begin
    if not exists(select 1 from notification_attempt a join notification_delivery d on d.intent_id=a.intent_id
      where a.id=NEW.attempt_id and d.state='IN_PROGRESS' and d.claim_token=a.claim_token
        and a.lease_until>gospaza_notification_now()) then
      raise exception 'Notification dispatch claim expired' using errcode='23514'; end if;
    return NEW;
   end;
   $gospaza$ language plpgsql`,
  `create trigger notification_started_guard before insert on notification_attempt_started for each row execute function gospaza_notification_started_guard()`,
  `create function gospaza_notification_evidence_guard() returns trigger as $gospaza$
   declare bound_intent text;
   begin
    select intent_id into bound_intent from notification_attempt where id=NEW.attempt_id;
    if bound_intent is null or (NEW.provider_id is not null and not exists(select 1 from notification_provider_message m where m.provider_id=NEW.provider_id and m.intent_id=bound_intent)) then
     raise exception 'Notification provider binding mismatch' using errcode='23514'; end if;
    return NEW;
   end;
   $gospaza$ language plpgsql`,
  `create trigger notification_result_binding before insert on notification_attempt_result for each row execute function gospaza_notification_evidence_guard()`,
  `create trigger notification_evidence_binding before insert on notification_provider_evidence for each row execute function gospaza_notification_evidence_guard()`,
  `create function gospaza_notification_consistency() returns trigger as $gospaza$
   declare target text; intent_row notification_intent%rowtype; delivery_row notification_delivery%rowtype;
   begin
    if TG_TABLE_NAME='notification_intent' then target:=NEW.id; else target:=NEW.intent_id; end if;
    select * into intent_row from notification_intent where id=target;
    select * into delivery_row from notification_delivery where intent_id=target;
    if not found or not exists(select 1 from notification_delivery_event e where e.intent_id=target and e.revision=delivery_row.revision and e.to_state=delivery_row.state)
      or delivery_row.attempts<>(select count(*) from notification_attempt a where a.intent_id=target)
      or (intent_row.channel='IN_APP' and (delivery_row.state<>'ACCEPTED' or not exists(select 1 from notification_notice n where n.intent_id=target)))
      or (intent_row.channel='EMAIL' and exists(select 1 from notification_notice n where n.intent_id=target))
      or (intent_row.channel='EMAIL' and delivery_row.state='ACCEPTED' and not exists(select 1 from notification_attempt a join notification_attempt_result r on r.attempt_id=a.id where a.intent_id=target and r.classification='ACCEPTED'))
      or (delivery_row.state='IN_PROGRESS' and not exists(select 1 from notification_attempt a where a.intent_id=target and a.attempt_number=delivery_row.attempts and a.claim_token=delivery_row.claim_token))
    then raise exception 'Notification consistency mismatch' using errcode='23514'; end if;
    return NEW;
   end;
   $gospaza$ language plpgsql`,
  ...["notification_intent", "notification_delivery", "notification_attempt"].map(table =>
    `create constraint trigger ${table}_consistent after insert or update on ${table} deferrable initially deferred for each row execute function gospaza_notification_consistency()`),
].map(sql => sql.replaceAll("clock_timestamp()", "gospaza_notification_now()"));
notificationSql.unshift(`create function gospaza_notification_now() returns timestamptz as $gospaza$
 begin return pg_catalog.clock_timestamp(); end;
 $gospaza$ language plpgsql`);
