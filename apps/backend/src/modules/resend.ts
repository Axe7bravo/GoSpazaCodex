import { AbstractNotificationProviderService, ModuleProvider, Modules } from "@medusajs/framework/utils";
import type { NotificationTypes } from "@medusajs/framework/types";
import { ResendHttpTransport } from "../lib/notification-transport";

export class ResendNotificationProvider extends AbstractNotificationProviderService {
  static identifier = "gospaza-resend";
  private readonly transport: ResendHttpTransport;
  constructor(_dependencies: Record<string, unknown>, options: { apiKey?: string } = {}, request: typeof fetch = fetch) {
    super();
    this.transport = new ResendHttpTransport(options.apiKey ?? "", request);
  }
  async send(notification: NotificationTypes.ProviderSendNotificationDTO): Promise<NotificationTypes.ProviderSendNotificationResultsDTO> {
    const result = await this.transport.send(notification);
    if (result.classification !== "ACCEPTED") throw new Error("M22|" + result.classification + "|" + result.code + "|");
    return { id: result.providerId };
  }
  // Integration-only retrieval, not a domain service or polling worker.
  async retrieve(knownProviderId: string) { return this.transport.retrieve(knownProviderId); }
}
export default ModuleProvider(Modules.NOTIFICATION, { services: [ResendNotificationProvider] });
