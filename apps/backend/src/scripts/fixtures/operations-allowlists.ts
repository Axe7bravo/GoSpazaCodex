import assert from "node:assert/strict";
export function exact(value: unknown, keys: string[]) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "Unexpected projection field.");
}
const safe = (value: unknown) => {
  const text = JSON.stringify(value) ?? "";
  for (const sentinel of ["private_sentinel", "school_uniform", "-29.12345", "@example.test"]) assert.ok(!text.includes(sentinel), "Private fixture evidence escaped projection.");
};
type Row = Record<string, unknown>;
const row = (value: unknown) => { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Row; };
const list = (value: unknown, max = 25) => { assert.ok(Array.isArray(value) && value.length <= max); return value as unknown[]; };
const link = (value: unknown) => { if (value !== null) assert.match(String(value), /^\/admin\/[a-z-]+(?:\/[A-Za-z0-9_-]+)?$/); };
export function assertOperationsProjection(kind: "overview" | "attention" | "order" | "delivery" | "timeline" | "health" | "lookup" | "rescue", value: unknown, optional: string[] = []) {
  safe(value); const v = row(value);
  switch (kind) {
    case "overview":
      exact(v, ["observed_at", "sections", "links", "navigation"]); exact(v.navigation, ["orders", "deliveries"]);
      for (const section of list(v.sections)) { const s = row(section); exact(s, s.availability === "AVAILABLE" ? ["source", "availability", "page"] : ["source", "availability"]);
        assert.ok(["AVAILABLE", "UNAVAILABLE"].includes(String(s.availability))); if (s.page) assertOperationsProjection("attention", s.page); }
      for (const link of list(v.links)) { exact(link, ["label", "href"]); assert.match(String(row(link).href), /^\/admin\/[a-z-]+$/); } break;
    case "attention":
      exact(v, ["source", "observed_at", "items", "next_cursor", "has_more", "page_count", "oldest_in_sample"]);
      for (const item of list(v.items)) { exact(item, ["domain", "record_type", "record_id", "reference", "category", "status", "reason_code", "created_at", "economic_at", "summary", "link"]); link(row(item).link); }
      assert.equal(v.page_count, list(v.items).length); break;
    case "order":
      exact(v, ["unavailable_sections", "order", "handoff", "operation", "store", "picking", ...optional]); exact(v.order, ["id", "status", "currency"]);
      if (v.operation) exact(v.operation, ["id", "status", "revision", "accepted_at", "rejected_at"]);
      if (v.store) exact(v.store, ["merchant_id", "store_id", "name"]); if (v.picking) exact(v.picking, ["status", "revision", "completed_at"]);
      if (v.delivery) assertOperationsProjection("delivery", v.delivery);
      if (v.finance) { exact(v.finance, ["items", "truncated"]); for (const f of list(row(v.finance).items)) { exact(f, ["id", "reason", "status", "amount_minor", "currency", "method", "refund_state", "credit_state"]); assert.match(String(row(f).amount_minor), /^-?\d+$/); } } break;
    case "delivery":
      exact(v, ["id", "order_id", "merchant_id", "store_id", "status", "revision", "generation", "mode", "path", "reason_code", "timing", "commitment", "pickup", "completion_state", "return_state", "rescue", ...(Object.hasOwn(v, "can_rescue") ? ["can_rescue"] : [])]);
      exact(v.timing, ["dispatch_not_before", "started_at", "deadline", "picked_up_at", "arrived_at", "delivered_at"]);
      if (v.commitment) exact(v.commitment, ["id", "status", "driver_profile_id", "expires_at", "assigned_at"]);
      exact(v.rescue, ["eligible", "scope", "block_reason", "requires_admission_revalidation"]);
      assert.equal(row(v.rescue).scope, "PERSISTED_PRECHECK"); assert.equal(row(v.rescue).requires_admission_revalidation, true);
      for (const p of list(v.pickup)) exact(p, ["action", "state"]); break;
    case "timeline":
      exact(v, ["observed_at", "pages"]); for (const page of list(v.pages)) { exact(page, ["source", "items", "next_cursor", "has_more"]);
        for (const entry of list(row(page).items)) { exact(entry, ["id", "domain", "timestamp", "label", "actor", "summary"]); assert.equal(row(entry).actor, "NOT_PROJECTED"); } } break;
    case "health":
      exact(v, ["observed_at", "workers", ...(v.notifications ? ["notifications"] : [])]);
      for (const worker of list(v.workers)) { exact(worker, ["name", "execution_health", "enabled", "sample_count", "has_more", "oldest_in_sample", "sample_kind"]); assert.equal(row(worker).execution_health, "NOT_INSTRUMENTED"); assert.ok(Number(row(worker).sample_count) <= 25); }
      if (v.notifications) { const n = row(v.notifications); exact(n, ["window_start", "sampled", "truncated", "states", "in_app", "email_attempts", "dispatched_attempts", "ambiguous", "stale_suppressions", "webhook_evidence", "retrieval_mismatches", "repair_discoveries", "oldest_pending_age_seconds", "workers"]);
        for (const [state, count] of Object.entries(row(n.states))) { assert.ok(["PENDING", "IN_PROGRESS", "ACCEPTED", "RETRYABLE_FAILURE", "TERMINAL_FAILURE", "ATTENTION_REQUIRED", "SUPPRESSED"].includes(state)); assert.ok(Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 10000); }
        for (const w of list(n.workers)) exact(w, ["name", "enabled", "last_success_at", "last_error"]); } break;
    case "lookup": exact(v, ["type", "id", "reference", "status", "link"]); link(v.link); break;
    case "rescue": exact(v, ["rescue_id", "delivery_id", "prior_generation", "generation", "revision", "status", "recorded_at"]); assert.equal(v.status, "SEARCHING"); break;
  }
}
