"use client";
import { createCustomerAuthClient } from "@gospaza/api-client";
export const authClient = createCustomerAuthClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL!,
  publishableKey: process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "",
});

