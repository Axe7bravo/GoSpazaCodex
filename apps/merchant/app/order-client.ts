"use client";
import { createMerchantOrderClient, OrderError } from "@gospaza/api-client";
export const orderClient = createMerchantOrderClient(process.env.NEXT_PUBLIC_API_URL!);
export const orderError = (error: unknown) => error instanceof OrderError ? error.message
  : "Order information is unavailable. Refresh before continuing.";
