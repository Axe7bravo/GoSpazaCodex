"use client";
import { createCatalogueClient } from "@gospaza/api-client";
export const catalogueClient = createCatalogueClient(process.env.NEXT_PUBLIC_API_URL!);
export function zar(cents: number) {
  const value = BigInt(cents);
  return (value / 100n).toString() + "." + (value % 100n).toString().padStart(2, "0");
}
export function cents(text: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("Enter a ZAR amount with at most two decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const value = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (value > 1000000000n) throw new Error("Price is too large.");
  return Number(value);
}
