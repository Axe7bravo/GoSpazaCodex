export const notificationMappingSql = [
  `alter table notification_intent drop constraint notification_intent_deep_link_check`,
  `alter table notification_intent add constraint notification_intent_deep_link_check check(deep_link is null or
    (length(deep_link)<=240 and (deep_link ~ '^/orders/[A-Za-z0-9_.:%-]+$' or
      deep_link ~ '^/merchant/(orders|picking|settlements)/[A-Za-z0-9_.:%-]+$' or
      deep_link ~ '^/admin/settlements/[A-Za-z0-9_.:%-]+$' or deep_link in ('/','/driver/earnings','/admin/financial-adjustments','/admin/driver-finance','/admin/commissions'))))`,
  // Audience snapshot, not a second notification identity. Individual intents
  // still converge exclusively through B's fact/kind/actor/channel uniqueness.
  `create table notification_mapping_audience (
    source_key text primary key check(length(source_key)=64), fingerprint text not null check(length(fingerprint)=64),
    recipients jsonb not null check(jsonb_typeof(recipients)='array' and jsonb_array_length(recipients)<=250 and octet_length(recipients::text)<=100000),
    created_at timestamptz not null default gospaza_notification_now())`,
  `create trigger notification_mapping_audience_immutable before update or delete on notification_mapping_audience
    for each row execute function gospaza_notification_immutable()`,
];
