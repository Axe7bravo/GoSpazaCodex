import { Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IApiKeyModuleService } from "@medusajs/framework/types";

export default async function createAuthPublishableKey({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("Local setup only.");
  const keys = container.resolve<IApiKeyModuleService>(Modules.API_KEY);
  const title = "GoSpaza local auth";
  const existing = await keys.listApiKeys({ title, type: "publishable" });
  const key = existing.find((key) => !key.revoked_at) ?? await keys.createApiKeys({ title, type: "publishable", created_by: "" });
  // Publishable key only; never print secret API keys or auth credentials.
  console.log("NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=" + key.token);
}

