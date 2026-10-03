"use client";
import { AuthError, createMerchantTeamClient } from "@gospaza/api-client";
export const merchantClient = createMerchantTeamClient(process.env.NEXT_PUBLIC_API_URL!);
export function merchantError(error: unknown) {
  return error instanceof AuthError ? error.message : "We cannot complete this request. Please try again.";
}
