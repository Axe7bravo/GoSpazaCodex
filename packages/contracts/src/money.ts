// Exact display of already-authoritative ZAR cents, shared by UI and messages.
export function formatZarMinor(value: string) {
  if (!/^-?\d{1,19}$/.test(value)) return "Amount unavailable";
  const minor = BigInt(value), negative = minor < 0n, absolute = negative ? -minor : minor, major = absolute / 100n;
  const display = negative ? (major === 0n ? -0 : -major) : major;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).formatToParts(display)
    .map(part => part.type === "fraction" ? fraction : part.value).join("");
}
