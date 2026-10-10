import type { IPaymentModuleService, MedusaContainer, PaymentSessionDTO } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type { Link } from "@medusajs/framework/modules-sdk";
import type { OperationRow } from "../modules/marketplace/provider-operation-store";
import { PgYocoOperationStore } from "../modules/marketplace/provider-operation-store";
import { nativePrice } from "../modules/marketplace/catalogue-policy";
import { YOCO_PROVIDER_ID } from "./yoco-config";
import { checkoutMoney } from "./checkout-native";
import { linkedCollection } from "./checkout-payment-links";
export { linkedCollection } from "./checkout-payment-links";

const conflict = () => new MedusaError(MedusaError.Types.CONFLICT, "CHECKOUT_NATIVE_STATE");

export async function establishPaymentCollection(
  container: MedusaContainer, row: OperationRow, cartId: string,
) {
  const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT);
  const store = new PgYocoOperationStore(container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION));
  let collectionId = row.payment_collection_id;
  if (!collectionId) {
    // 2.18 upsert with an ID updates only; it cannot create a chosen ID.
    // Public filters do not support metadata, so recovery reads one native
    // snapshot of IDs/markers. Never re-create before checking for a lost result.
    const candidates = (await payments.listPaymentCollections({}, {
      select: ["id", "metadata"], take: null,
    })).filter((collection) => collection.metadata?.gospaza_operation_id === row.id);
    if (candidates.length > 1) throw conflict();
    const candidate = candidates[0] ?? await payments.createPaymentCollections({
      amount: nativePrice(Number(row.amount_minor)), currency_code: row.currency_code,
      metadata: { gospaza_operation_id: row.id },
    });
    collectionId = candidate.id;
    await store.attachCollection(row.id, collectionId);
  }
  const collection = await payments.retrievePaymentCollection(collectionId, { relations: ["payment_sessions", "payments"] });
  if (collection.metadata?.gospaza_operation_id !== row.id || collection.currency_code !== row.currency_code
    || checkoutMoney(collection.amount) !== Number(row.amount_minor)) throw conflict();
  const linked = await linkedCollection(container, cartId);
  if (linked && linked !== collectionId) throw conflict();
  if (!linked) {
    await container.resolve<Link>(ContainerRegistrationKeys.LINK).create({
      [Modules.CART]: { cart_id: cartId }, [Modules.PAYMENT]: { payment_collection_id: collectionId },
    });
  }
  return collection;
}

export async function establishPaymentSession(
  container: MedusaContainer, operationId: string, recover: boolean,
): Promise<PaymentSessionDTO> {
  const store = new PgYocoOperationStore(container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION));
  const row = await store.row(operationId);
  if (!row.payment_collection_id) throw conflict();
  const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT);
  const collection = await payments.retrievePaymentCollection(row.payment_collection_id, {
    relations: ["payment_sessions", "payments", "payments.payment_session"],
  });
  const sessions = collection.payment_sessions ?? [];
  const nativePayments = collection.payments ?? [];
  if (nativePayments.length || row.financial_session_id) {
    const selected = sessions.find((session) => session.id === row.financial_session_id);
    if (nativePayments.length !== 1 || !selected || selected.data?.operation_id !== row.id
      || nativePayments[0]?.payment_session?.id !== selected.id) throw conflict();
    return selected;
  }
  if (sessions.length > 1) throw conflict();
  let session = sessions[0];
  if (session) {
    if (session.provider_id !== YOCO_PROVIDER_ID || session.payment_collection_id !== row.payment_collection_id
      || session.data?.operation_id !== row.id || checkoutMoney(session.amount) !== Number(row.amount_minor)
      || session.currency_code !== row.currency_code) throw conflict();
    let operation = await store.read(row.id);
    if (!operation?.sessionIds.includes(session.id)) {
      // Native creation may commit before the provider callback ever runs.
      // The stored one-use permit is the only acceptable missing association.
      if (!recover || typeof session.data.session_token !== "string") throw conflict();
      await store.associateSession(row.id, session.id, session.data.session_token);
      operation = await store.read(row.id);
    }
    if (!operation) throw conflict();
    const externalId = operation.checkoutId ?? operation.checkout?.id;
    const complete = (operation.checkout || operation.payment)
      && session.data.session_id === session.id && session.data.yocoCheckoutId === externalId;
    // A crash can leave an unmaterialized native session. Only explicit
    // recovery may replace it, after proving no Payment exists. Deletion does
    // not cancel Yoco; the append-only association and exact request survive.
    if (!complete) {
      if (!recover || session.authorized_at || row.financial_session_id) throw conflict();
      await payments.deletePaymentSession(session.id);
      session = undefined;
    }
  }
  if (!session) {
    const token = await store.permitSession(row.id, recover);
    session = await payments.createPaymentSession(row.payment_collection_id, {
      provider_id: YOCO_PROVIDER_ID, amount: nativePrice(Number(row.amount_minor)), currency_code: row.currency_code,
      data: { operation_id: row.id, session_token: token },
    });
  }
  await store.selectCanonical(row.id, session.id);
  return session;
}
