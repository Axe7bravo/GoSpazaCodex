"use client";
import { createAdminDriverClient } from "@gospaza/api-client";
export const driverClient = createAdminDriverClient(process.env.NEXT_PUBLIC_API_URL!);
export const driverDenied = () => window.location.replace("/login");
