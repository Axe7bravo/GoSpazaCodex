import type { ICartModuleService, IOrderModuleService, MedusaContainer, OrderDTO } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import type { MerchantOrder } from "@gospaza/contracts";
import type { CompletedOrderHandoff } from "../modules/marketplace/order-operation-policy";
import { orderUnavailable } from "../modules/marketplace/order-operation-policy";
import type { OrderOperationRow } from "../modules/marketplace/order-operation-repository";
import { checkoutMoney } from "./checkout-native";

export async function readOperationalOrder(container: MedusaContainer, handoff: CompletedOrderHandoff): Promise<OrderDTO> {
  // Identity readback, not a second payment reconciliation. M10's durable
  // receipt remains the proof of its accepted commercial outcome.
  const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>(ContainerRegistrationKeys.QUERY);
  const linked = await query.graph({ entity: "order_cart", fields: ["order_id", "cart_id"], filters: { order_id: handoff.order_id } });
  const links = z.array(z.object({ order_id: z.string(), cart_id: z.string() })).safeParse(linked.data);
  if (!links.success || links.data.length !== 1 || links.data[0]?.cart_id !== handoff.cart_id
    || links.data[0]?.order_id !== handoff.order_id) throw orderUnavailable();
  let order: OrderDTO;
  try {
    order = await container.resolve<IOrderModuleService>(Modules.ORDER).retrieveOrder(handoff.order_id, {
      select: ["id", "display_id", "created_at", "customer_id", "sales_channel_id", "status", "currency_code",
        "total", "subtotal", "tax_total", "discount_total", "shipping_total"],
      relations: ["items", "items.tax_lines", "items.adjustments", "shipping_methods",
        "shipping_methods.tax_lines", "shipping_methods.adjustments", "shipping_address"],
    });
    const cart = await container.resolve<ICartModuleService>(Modules.CART).retrieveCart(handoff.cart_id);
    if (!cart.completed_at || cart.customer_id !== handoff.snapshot.customer_id || order.customer_id !== cart.customer_id
      || order.sales_channel_id !== cart.sales_channel_id) throw orderUnavailable();
  } catch { throw orderUnavailable(); }
  // Do not hide foreign/changed lines by filtering them out. Compare the native
  // line identities to the single-store snapshot accepted by M10.
  const signature = (items: { variant_id?: string | null; quantity: unknown }[]) => items
    .map((item) => [item.variant_id, Number(item.quantity)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (order.id !== handoff.order_id || order.status === "canceled" || order.currency_code !== "zar"
    || !order.items?.length || !order.shipping_address
    || order.shipping_methods?.length !== 1 || order.shipping_methods[0]?.shipping_option_id !== handoff.snapshot.shipping_option_id
    || JSON.stringify(signature(order.items)) !== JSON.stringify(signature(handoff.snapshot.items))) throw orderUnavailable();
  return order;
}

export interface OperationalDelivery {
  start_at: Date | string; end_at: Date | string;
  name: string; address_line_1: string; address_line_2: string; city: string;
  province: string; postal_code: string; country_code: string;
}
export function merchantOrderDTO(order: OrderDTO, operation: OrderOperationRow, delivery: OperationalDelivery): MerchantOrder {
  if (order.currency_code !== "zar" || !order.items?.length || !order.shipping_address) throw orderUnavailable();
  return {
    id: order.id, display_id: order.display_id, created_at: new Date(order.created_at).toISOString(),
    operational_status: operation.status, revision: operation.revision, currency_code: "zar",
    accepted_at: operation.accepted_at ? new Date(operation.accepted_at).toISOString() : null,
    rejected_at: operation.rejected_at ? new Date(operation.rejected_at).toISOString() : null,
    rejection_reason: operation.rejection_reason,
    customer: { first_name: order.shipping_address.first_name ?? "", last_name: order.shipping_address.last_name ?? "", city: order.shipping_address.city ?? "" },
    items: order.items.map((item) => {
      const quantity = Number(item.quantity);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw orderUnavailable();
      return { id: item.id, title: item.title, variant_title: item.variant_title ?? null, sku: item.variant_sku ?? null,
        quantity, unit_price_minor: checkoutMoney(item.unit_price), total_minor: checkoutMoney(item.total) };
    }),
    totals: { total_minor: checkoutMoney(order.total), subtotal_minor: checkoutMoney(order.subtotal),
      tax_total_minor: checkoutMoney(order.tax_total), discount_total_minor: checkoutMoney(order.discount_total), shipping_total_minor: checkoutMoney(order.shipping_total) },
    delivery: { starts_at: new Date(delivery.start_at).toISOString(), ends_at: new Date(delivery.end_at).toISOString(), shipping_name: order.shipping_methods?.[0]?.name ?? "" },
    pickup: { store_name: delivery.name, address_line_1: delivery.address_line_1, address_line_2: delivery.address_line_2,
      city: delivery.city, province: delivery.province, postal_code: delivery.postal_code, country_code: delivery.country_code },
  };
}
