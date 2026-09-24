"use client";
import { createAuthClient } from "@gospaza/api-client";
export const authClient = createAuthClient("driver", {
  baseUrl: process.env.NEXT_PUBLIC_API_URL!,
  
});

