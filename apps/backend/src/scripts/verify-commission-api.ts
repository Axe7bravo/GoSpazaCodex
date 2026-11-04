import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExecArgs } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { commissionActorFile, commissionFixturePassword } from "./fixtures/commission-actors";
import { withRetainedCheckoutAfterReconciliation } from "./verify-payment-reconciliation";
import { OrderOperationsService } from "../lib/order-operations-service";

export default async function verifyCommissionApi(args: ExecArgs) {
  const actor = z.object({ id: z.string(), email: z.string().endsWith("@example.test") });
  const manifest = z.object({ writer: actor, viewer: actor }).parse(JSON.parse(await readFile(commissionActorFile, "utf8")));
  const base = new URL(process.env.BACKEND_URL ?? "");
  if (!["localhost","127.0.0.1","[::1]"].includes(base.hostname)) throw new Error("Local isolated test backend required.");
  await withRetainedCheckoutAfterReconciliation(args, async fixture => {
    const { container, second } = fixture.fixture;
    const login = async (email: string) => {
      const response = await fixture.http("", "POST", "/auth/user/emailpass", { email, password: commissionFixturePassword(email) });
      const { token } = z.object({ token: z.string() }).parse(fixture.expect(response));
      const session = await fetch(new URL("/auth/session", base), { method: "POST", headers: { Authorization: "Bearer " + token } });
      assert.equal(session.status, 200);
      const cookie = session.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
      assert.ok(cookie); return cookie;
    };
    const writer = await login(manifest.writer.email), viewer = await login(manifest.viewer.email);
    const rules = "/admin/gospaza/commission-rules";
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const decision = { scope:"MERCHANT", merchant_id:second.merchantId, decision:"SET", basis_points:800,
      expected_revision:0, request_id:"rule_"+randomUUID(), confirmed:true, reason:"Isolated historical rate proof" };
    try {
      fixture.expect(await fixture.http(viewer,"POST",rules,decision),403);
      fixture.expect(await fixture.http(writer,"POST",rules,{...decision,commission_minor:800}),400);
      const publish = () => fixture.http(writer,"POST",rules,decision);
      const [first,replay] = await Promise.all([publish(),publish()]);
      const published = z.object({id:z.string(),revision:z.literal(1)}).parse(fixture.expect(first));
      assert.deepEqual(fixture.expect(replay),first.body);
      const order = await fixture.complete("m19-frozen-order",second.variantId,1);
      await new OrderOperationsService(container).ensure(order.orderId);
      const changeRate=()=>fixture.http(writer,"POST",rules,{...decision,basis_points:1200,expected_revision:1,request_id:"rule_"+randomUUID()});
      const changes=await Promise.all([changeRate(),changeRate()]);
      assert.deepEqual(changes.map(response=>response.status).sort(),[200,409]);
      fixture.expect(await fixture.http(viewer,"GET",rules+"?merchant_id="+second.merchantId));
      const path="/admin/gospaza/orders/"+order.orderId+"/finance-snapshot";
      fixture.expect(await fixture.http(writer,"GET",path),403);
      fixture.expect(await fixture.http(order.person.cookie,"GET",path),401);
      fixture.expect(await fixture.http(viewer,"GET",path+"?commission_minor=999"),400);
      const read = () => fixture.http(viewer,"GET",path);
      const [left,right] = await Promise.all([read(),read()]);
      const result=z.object({state:z.literal("RESOLVED"),rule_id:z.literal(published.id),basis_points:z.literal(800),
        evidence:z.object({basis_minor:z.number().int().positive()}),exceptions:z.array(z.unknown()).length(0)}).parse(fixture.expect(left));
      assert.deepEqual(fixture.expect(right),left.body);
      assert.equal(result.rule_id,published.id);
      assert.equal((await db("order_finance_snapshot").where({order_id:order.orderId}).select("id")).length,1);
      assert.equal((await db("commission_rule_audit").where({rule_id:published.id})).length,1);
      for(const key of ["customer_id","account_id","capture_id","payment_id","provider_refund_id"])
        assert.equal(JSON.stringify(left.body).includes('"'+key+'"'),false);
      console.log("M19-B real API publication, grants, delayed 800-bps snapshot and concurrent committed replay passed.");
    } finally {
      await fixture.http(writer,"DELETE","/auth/session");
      await fixture.http(viewer,"DELETE","/auth/session");
    }
  });
}
