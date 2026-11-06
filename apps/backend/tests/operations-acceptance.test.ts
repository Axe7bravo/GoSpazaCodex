import assert from "node:assert/strict";
import test from "node:test";
import { assertOperationsProjection, exact } from "../src/scripts/fixtures/operations-allowlists";
import { operationsSchema } from "../src/scripts/fixtures/operations-acceptance";

test("M23-D selector requires the established database, Redis /1, test/test and bounded schema", () => {
  const schema = "m23_acceptance_" + "a".repeat(32), env = { DATABASE_URL: "postgres://fixture:unused@localhost/gospaza_m18_c2b_test", REDIS_URL: "redis://localhost/1", NODE_ENV: "test", APP_ENV: "test" };
  assert.equal(operationsSchema(schema, env), schema);
  for (const change of [{ DATABASE_URL: "postgres://localhost/gospaza" }, { DATABASE_URL: "postgres://localhost/gospaza_test" }, { REDIS_URL: "redis://localhost/0" }, { APP_ENV: "production" }, { NODE_ENV: "development" }]) assert.throws(() => operationsSchema(schema, { ...env, ...change }));
  assert.throws(() => operationsSchema("public", env)); assert.throws(() => operationsSchema(schema + ";drop schema public", env));
});
test("M23-D nested allowlists reject extra private fields and unauthorized order sections", () => {
  const order = { unavailable_sections: [], order: { id: "order_a", status: "pending", currency: "zar" }, handoff: "VERIFIED", operation: null, store: null, picking: null };
  assertOperationsProjection("order", order);
  assert.throws(() => assertOperationsProjection("order", { ...order, finance: { items: [], truncated: false } }));
  assert.throws(() => assertOperationsProjection("order", { ...order, order: { ...order.order, customer_email: "private@example.test" } }));
  assert.throws(() => exact({ id: "a", otp_hash: "secret" }, ["id"]));
  const timeline = { observed_at: "2026-11-06T12:00:00Z", pages: [{ source: "decision", items: [{ id: "event_a", domain: "decision", timestamp: "2026-11-06T12:00:00Z", label: "Recorded", actor: "NOT_PROJECTED", summary: "Recorded" }], next_cursor: null, has_more: false }] };
  assertOperationsProjection("timeline", timeline);
  assert.throws(() => assertOperationsProjection("timeline", { ...timeline, pages: [{ ...timeline.pages[0], items: [{ ...timeline.pages[0]?.items[0], evidence: {} }] }] }));
  assert.throws(() => assertOperationsProjection("timeline", { ...timeline, pages: [{ ...timeline.pages[0], items: [{ ...timeline.pages[0]?.items[0], summary: "school_uniform" }] }] }));
});
test("M23-D health cannot silently convert uninstrumented work into healthy execution", () => {
  const worker = { name: "Dispatch", execution_health: "NOT_INSTRUMENTED", enabled: false, sample_count: 0, has_more: false, oldest_in_sample: null, sample_kind: "DUE_WORK" };
  const health = { observed_at: "2026-11-06T12:00:00Z", workers: [worker] }; assertOperationsProjection("health", health);
  assert.throws(() => assertOperationsProjection("health", { ...health, workers: [{ ...worker, execution_health: "HEALTHY" }] }));
  assert.throws(() => assertOperationsProjection("health", { ...health, workers: [{ ...worker, sample_count: 26 }] }));
});
test("M23-D attention and rescue envelopes remain bounded and cannot carry provider evidence", () => {
  const page = { source: "deliveries", observed_at: "2026-11-06T12:00:00Z", items: [], next_cursor: null, has_more: false, page_count: 0, oldest_in_sample: null }; assertOperationsProjection("attention", page);
  assert.throws(() => assertOperationsProjection("attention", { ...page, items: Array.from({ length: 26 }, () => ({})) }));
  const rescue = { rescue_id: "rescue_a", delivery_id: "delivery_a", prior_generation: 1, generation: 2, revision: 5, status: "SEARCHING", recorded_at: "2026-11-06T12:00:00Z" }; assertOperationsProjection("rescue", rescue);
  assert.throws(() => assertOperationsProjection("rescue", { ...rescue, driver_id: "driver_forced" }));
  assert.throws(() => assertOperationsProjection("rescue", { ...rescue, status: "ASSIGNED" }));
});
