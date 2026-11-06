import assert from "node:assert/strict";
import test from "node:test";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { CompletedOrderHandoff } from "../src/modules/marketplace/order-operation-policy";
import { MedusaError } from "@medusajs/framework/utils";
import { RestrictedDeliveryDocument } from "../src/lib/restricted-delivery-document";
test("M23-C existing-only document admission rejects missing evidence before any native service or mutation", async () => {
  let reads = 0, nativeCalls = 0;
  const trx = ((table: string) => {
    assert.equal(table, "restricted_delivery_document");
    return { where: () => ({ first: async () => { reads++; return undefined; } }) };
  }) as unknown as Knex.Transaction;
  const container = { resolve: () => { nativeCalls++; throw Error("No native service should run for missing evidence"); } } as unknown as MedusaContainer;
  // The method must reject before inspecting an untrusted/incomplete handoff.
  await assert.rejects(new RestrictedDeliveryDocument(container).ensure(trx, "operation", {} as CompletedOrderHandoff, [], true), error => MedusaError.isMedusaError(error) && error.type === MedusaError.Types.CONFLICT);
  assert.equal(reads, 1); assert.equal(nativeCalls, 0);
});
