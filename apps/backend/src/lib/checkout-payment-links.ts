import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type { Link } from "@medusajs/framework/modules-sdk";

const conflict = () => new MedusaError(MedusaError.Types.CONFLICT, "CHECKOUT_NATIVE_STATE");
type CartPayment = { id: string; payment_collection?: { id: string } | null };
export async function linkedCollection(container: MedusaContainer, cartId: string) {
  const query = container.resolve<{
    graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: CartPayment[] }>;
  }>(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({ entity: "cart", fields: ["id", "payment_collection.id"], filters: { id: cartId } });
  if (data.length !== 1 || data[0]?.id !== cartId) throw conflict();
  return data[0].payment_collection?.id ?? null;
}

// Caller owns the customer lock. Detach ONLY a proven historical operation's
// collection; never delete its sessions/payments or adopt an unrelated collection.
export async function detachHistoricalCollection(container: MedusaContainer, cartId: string): Promise<void> {
  const id = await linkedCollection(container, cartId);
  if (!id) return;
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const historical = await db("provider_operation as o")
    .join("checkout_attempt as a", "a.id", "o.checkout_attempt_id")
    .where({ "o.payment_collection_id": id, "a.medusa_cart_id": cartId })
    .whereNotNull("a.closed_at").whereNull("o.deleted_at").first("o.id");
  if (!historical) throw conflict();
  await container.resolve<Link>(ContainerRegistrationKeys.LINK).dismiss({
    [Modules.CART]: { cart_id: cartId }, [Modules.PAYMENT]: { payment_collection_id: id },
  });
  if (await linkedCollection(container, cartId)) throw conflict();
}

