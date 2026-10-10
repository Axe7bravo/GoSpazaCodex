import assert from "node:assert/strict";
import { test } from "node:test";
import { MedusaError, serializeError } from "@medusajs/framework/utils";
import { cartMutationFailure } from "../src/lib/cart-errors";

test("serialized native inventory errors preserve the inventory conflict response", () => {
  const error = new MedusaError(MedusaError.Types.NOT_ALLOWED, "Native inventory rejection",
    MedusaError.Codes.INSUFFICIENT_INVENTORY);
  const serialized = serializeError(error);
  assert.equal(serialized instanceof MedusaError, false);
  assert.deepEqual(cartMutationFailure(serialized, true), cartMutationFailure(error, true));
  assert.equal(cartMutationFailure(serialized, true).status, 409);
  assert.equal(cartMutationFailure(serialized, true).body.code, "CART_INVENTORY_UNAVAILABLE");
});

test("direct and serialized pre-mutation merchant conflicts retain 409", () => {
  const error = new MedusaError(MedusaError.Types.CONFLICT, "CART_MERCHANT_CONFLICT");
  for (const value of [error, serializeError(error)]) {
    const result = cartMutationFailure(value, false);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "CART_MERCHANT_CONFLICT");
  }
});

test("unknown pre-mutation failures are unavailable, not uncertain writes", () => {
  for (const error of [null, undefined, "failure", new Error("Database read failed")]) {
    const result = cartMutationFailure(error, false);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "CART_UNAVAILABLE");
  }
});

test("unknown post-entry and compensation failures remain uncertain", () => {
  const inventory = new MedusaError(MedusaError.Types.NOT_ALLOWED, "Inventory", MedusaError.Codes.INSUFFICIENT_INVENTORY);
  for (const error of [
    new Error("Connection lost"),
    new Error("Compensation failed", { cause: inventory }),
    new AggregateError([inventory, new Error("Cleanup failed")], "Workflow failed"),
  ]) {
    const result = cartMutationFailure(error, true);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "CART_MUTATION_UNCERTAIN");
  }
});

test("checkout freeze is a deliberate pre-mutation conflict, not an uncertain native write", () => {
  const error = new MedusaError(MedusaError.Types.CONFLICT, "CHECKOUT_FROZEN");
  for (const value of [error, serializeError(error)]) {
    const result = cartMutationFailure(value, false);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "CHECKOUT_FROZEN");
  }
});
