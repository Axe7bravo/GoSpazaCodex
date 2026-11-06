export interface ActorNotice {
  id: string; kind: string; title: string; body: string; deep_link: string | null;
  created_at: string; read_at: string | null;
}
export interface NoticePage { notifications: ActorNotice[]; next_cursor: string | null }
export type NotificationTransportDisposition = "accepted" | "sent" | "delivery_delayed" | "delivered" | "failed" | "bounced" | "complained";
export interface NotificationOperation {
  id: string; kind: string; channel: "IN_APP" | "EMAIL"; state: string; attempts: number;
  created_at: string; accepted_at: string | null; last_code: string;
  transport_disposition: NotificationTransportDisposition | null;
}
export interface NotificationOperationPage { operations: NotificationOperation[]; next_cursor: string | null }
export interface NotificationWorkerHealth { name: string; enabled: boolean; last_success_at: string | null; last_error: string | null }
export interface NotificationHealth {
  window_start: string; sampled: number; truncated: boolean; states: Record<string, number>;
  in_app: number; email_attempts: number; dispatched_attempts: number; ambiguous: number; stale_suppressions: number;
  webhook_evidence: number; retrieval_mismatches: number; repair_discoveries: number;
  oldest_pending_age_seconds: number | null; workers: NotificationWorkerHealth[];
}
