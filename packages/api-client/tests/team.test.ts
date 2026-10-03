import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, createMerchantTeamClient } from "../src/index";

test("acceptance sends the secret only in a credentialed POST body", async () => {
  const token = "A".repeat(43);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(url, "http://localhost:9000/merchant/team/invitations/accept");
    assert.ok(!url.includes(token));
    assert.equal(init?.credentials, "include");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), { token });
    return Response.json({ member_id: "mmem_fixture" });
  };
  assert.deepEqual(await createMerchantTeamClient("http://localhost:9000", fetcher).accept(token), { member_id: "mmem_fixture" });
});

test("team errors retain HTTP meaning without exposing backend bodies", async () => {
  for (const status of [401, 403, 404, 409, 429, 500]) {
    const fetcher: typeof fetch = async () => Response.json({ message: "sensitive-backend-details" }, { status });
    await assert.rejects(createMerchantTeamClient("http://localhost:9000", fetcher).accept("A".repeat(43)), (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("sensitive-backend-details"));
      if (status === 401) assert.equal(error.kind, "unauthorized");
      if (status === 409) assert.match(error.message, /expired, revoked, used/);
      return true;
    });
  }
});

test("team networking failures stay unavailable and unsafe API URLs fail", async () => {
  const unavailable: typeof fetch = async () => { throw new Error("network internals"); };
  await assert.rejects(createMerchantTeamClient("http://localhost:9000", unavailable).context(), { kind: "unavailable" });
  assert.throws(() => createMerchantTeamClient("https://user:secret@example.test"), { kind: "configuration" });
});
