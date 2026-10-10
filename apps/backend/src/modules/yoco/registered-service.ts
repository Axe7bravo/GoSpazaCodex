import type { WebhookActionResult } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { PgYocoOperationStore } from "../marketplace/provider-operation-store";
import YocoPaymentService from "./service";
import type { YocoOptions, YocoWebhookPayload } from "./types";

// Medusa 2.18 load-internal injects PG_CONNECTION into the module container.
// Provider registration receives that same container. No private payment service
// or native-table access is used; the adapter only owns Marketplace tables.
export default class RegisteredYocoPaymentService extends YocoPaymentService {
  static identifier = "yoco";
  // Even an already-queued native webhook event cannot enter Medusa's automatic
  // process-payment/cart completion subscriber. Dedicated ingress owns dispatch.
  async getWebhookActionAndData(_input: YocoWebhookPayload): Promise<WebhookActionResult> {
    return { action: "not_supported" };
  }
  constructor(container: { __pg_connection__: Knex }, configuration: YocoOptions) {
    super({ yocoOperations: new PgYocoOperationStore(container.__pg_connection__) }, configuration);
  }
}
