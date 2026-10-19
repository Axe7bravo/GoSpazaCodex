"use client";
import { createDriverAuthClient, createDriverClient } from "@gospaza/api-client";
export const authClient = createDriverAuthClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL! });
export const driverClient = createDriverClient(process.env.NEXT_PUBLIC_API_URL!);
