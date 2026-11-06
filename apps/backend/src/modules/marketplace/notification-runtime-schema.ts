export const notificationRuntimeSql = [
  `create table notification_worker_health(name text primary key check(name in ('delivery','repair')),
    last_success_at timestamptz,last_error text check(last_error ~ '^[A-Z_]{1,60}$'),updated_at timestamptz not null default gospaza_notification_now())`,
  `create table notification_repair_checkpoint(family text primary key,window_start timestamptz not null,window_end timestamptz not null,
    cursor_at timestamptz,cursor_id text,lease_token text,lease_until timestamptz,last_scanned_at timestamptz,next_cycle_at timestamptz,
    check(window_end>=window_start),check((cursor_at is null)=(cursor_id is null)),check((lease_token is null)=(lease_until is null)))`,
  `create table notification_runtime_observation(id bigserial primary key,category text not null check(category in
    ('REPAIR_DISCOVERED','REPAIR_FAILURE','RETRIEVAL_MISMATCH','WEBHOOK_CONFLICT')),recorded_at timestamptz not null default gospaza_notification_now())`,
  `create table notification_webhook_receipt(event_id text primary key,provider_id text not null references notification_provider_message(provider_id),
    fingerprint text not null check(length(fingerprint)=64),received_at timestamptz not null default gospaza_notification_now())`,
  `create table notification_provider_observation(provider_id text not null references notification_provider_message(provider_id),
    event_type text not null check(event_type in ('sent','delivered','delivery_delayed','bounced','complained','failed')),
    first_observed_at timestamptz not null default gospaza_notification_now(),primary key(provider_id,event_type))`,
  `create trigger notification_webhook_receipt_immutable before update or delete on notification_webhook_receipt
    for each row execute function gospaza_notification_immutable()`,
  `create trigger notification_provider_observation_immutable before update or delete on notification_provider_observation
    for each row execute function gospaza_notification_immutable()`,
  `create trigger notification_runtime_observation_immutable before update or delete on notification_runtime_observation
    for each row execute function gospaza_notification_immutable()`,
  `create index notification_notice_page on notification_notice(created_at,intent_id)`,
  `create index notification_intent_ops_page on notification_intent(created_at,id)`,
  `create index notification_attempt_started_page on notification_attempt_started(dispatched_at)`,
  `create index notification_attempt_page on notification_attempt(started_at)`,
  `create index notification_attempt_result_page on notification_attempt_result(completed_at)`,
  `create index notification_evidence_page on notification_provider_evidence(received_at)`,
  `create index notification_observation_page on notification_runtime_observation(recorded_at)`,
  // These are owning-domain audit discovery indexes, not changed domain rules.
  ...[["order_decision_event", "decided_at"], ["pick_event", "occurred_at"], ["shortage_resolution", "created_at"], ["dispatch_event", "occurred_at"],
    ["restricted_event", "created_at"], ["refund_event", "created_at"], ["store_credit_operation_event", "occurred_at"],
    ["settlement_transition_audit", "recorded_at"], ["merchant_settlement_command", "recorded_at"],
    ["driver_payment_command", "recorded_at"], ["order_finance_exception", "recorded_at"], ["driver_earning_exception", "recorded_at"]]
    .map(([table, column]) => `create index notification_discovery_${table} on ${table}(${column})`),
  // Match the exact expression used by bounded terminal checkout discovery.
  `create index notification_discovery_checkout on checkout_completion((terminal_receipt->>'verified_at'),id) where state='SUCCEEDED'`,
];
