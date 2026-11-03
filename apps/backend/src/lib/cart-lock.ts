import { createHash } from "node:crypto";
import { Client } from "pg";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";

class InitializationBusy extends Error {}

function cartKey(customerId: string) {
  return createHash("sha256").update("gospaza:customer-cart:" + customerId).digest().readBigInt64BE();
}

function initializedChannel(customerId: string) {
  return "gospaza_cart_ready_" + BigInt.asUintN(64, cartKey(customerId)).toString(16);
}

// Hold across native workflows AND compensation. Native persistence does not
// participate in this transaction; it provides the outer serialization boundary.
export async function cartOperation<T>(container: MedusaContainer, customerId: string,
  work: () => Promise<T>, admission?: "pay" | "cart-mutation" | "initialize"): Promise<T> {
  if (!customerId) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Sign in required.");
  const key = cartKey(customerId).toString();

  return container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION).transaction(async (trx) => {

    await trx.raw("SET LOCAL lock_timeout = '10s'");
    try {
      await trx.raw("select pg_advisory_xact_lock(?::bigint)", [key]);
    } catch (error) {
      if (admission && error instanceof Error && "code" in error && error.code === "55P03") {
        if (admission === "initialize") throw new InitializationBusy("Cart initialization is in progress", { cause: error });
        const code = admission === "pay" ? "CHECKOUT_ALREADY_PROCESSING" : "CART_STATE_CONFLICT";
        throw new MedusaError(MedusaError.Types.CONFLICT, code, code);
      }
      throw error;
    }
    if (admission !== "initialize") return work();
    const result = await work();
    // Publication is delivered only when the outer cart transaction commits.
    await trx.raw("select pg_notify(?, '')", [initializedChannel(customerId)]);
    return result;
  });
}

export async function initializeCartOperation(container: MedusaContainer, customerId: string,
  createOrRestore: () => Promise<string>, restorePublished: () => Promise<string>): Promise<string> {
  try { return await cartOperation(container, customerId, createOrRestore, "initialize"); }
  catch (error) {
    if (!(error instanceof InitializationBusy)) throw error;
    // LISTEN before probing the key so publication just before subscription is
    // observable too. Never run creation again from this path. A separate short-
    // lived connection leaves the native workflow's connection pool available.
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const listener = new Client(db.client.connectionSettings);
    const channel = initializedChannel(customerId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let published!: () => void;
    let failed!: (reason: Error) => void;
    const notification = new Promise<void>((resolve, reject) => { published = resolve; failed = reject; });
    // A connection error may arrive while LISTEN or the lock probe is in flight.
    void notification.catch(() => {});
    listener.on("error", failed);
    listener.on("notification", message => { if (message.channel === channel) published(); });
    try {
      await listener.connect();
      await listener.query("LISTEN " + channel); // server-generated hex identifier
      const probe = await listener.query<{ released: boolean }>("select pg_try_advisory_xact_lock($1::bigint) as released", [cartKey(customerId).toString()]);
      if (!probe.rows[0]?.released) {
        timer = setTimeout(() => failed(error), 60_000);
        await notification;
      }
    } finally {
      clearTimeout(timer);
      await listener.end();
    }
    return cartOperation(container, customerId, restorePublished);
  }
}
