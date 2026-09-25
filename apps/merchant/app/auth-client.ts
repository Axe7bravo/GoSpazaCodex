"use client";
import { createApplicantAuthClient } from "@gospaza/api-client";
export const authClient = createApplicantAuthClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL!,
  
});

