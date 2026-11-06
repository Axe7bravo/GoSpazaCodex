import assert from "node:assert/strict";
import test from "node:test";
import { AuthError } from "@gospaza/api-client";
import { rescueAndRefresh } from "../app/operations-rescue";
test("M23-C rescue success and stale conflict always refetch persisted state", async () => {
  const events: string[] = [];
  assert.equal(await rescueAndRefresh(async () => { events.push("write"); }, async () => { events.push("read"); return true; }), "RECORDED");
  assert.deepEqual(events, ["write", "read"]); events.length = 0;
  assert.equal(await rescueAndRefresh(async () => { events.push("write"); throw new AuthError("validation", "changed", 409); }, async () => { events.push("read"); return true; }), "CONFLICT");
  assert.deepEqual(events, ["write", "read"]);
});
test("M23-C uncertain rescue reads back without automatic resubmission", async () => {
  let writes = 0, reads = 0;
  assert.equal(await rescueAndRefresh(async () => { writes++; throw Error("lost response"); }, async () => { reads++; return false; }), "UNCERTAIN");
  assert.equal(writes, 1); assert.equal(reads, 1);
});
