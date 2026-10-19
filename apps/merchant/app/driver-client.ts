"use client";
import { createMerchantDriverClient } from "@gospaza/api-client";
export const driverClient = createMerchantDriverClient(process.env.NEXT_PUBLIC_API_URL!);
