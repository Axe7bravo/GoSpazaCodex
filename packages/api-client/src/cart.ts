import type {
  AddCartItemInput, CartFoundation, CartMutationResult,
  SwitchCartStoreInput, UpdateCartItemInput,
} from "@gospaza/contracts";

export type CartErrorCode =
  | "CART_MERCHANT_CONFLICT"
  | "CART_STATE_CONFLICT"
  | "CART_INVENTORY_UNAVAILABLE"
  | "CART_MUTATION_UNCERTAIN"
  | "CART_UNAVAILABLE";

export class CartError extends Error {
  constructor(
    public readonly kind: "conflict" | "uncertain" | "validation" | "unauthorized" | "unavailable",
    message: string,
    public readonly status: number,
    public readonly code?: CartErrorCode,
  ) {
    super(message);
    this.name = "CartError";
  }
}

interface ErrorBody { code?: unknown }
const cartCodes: CartErrorCode[] = [
  "CART_MERCHANT_CONFLICT", "CART_STATE_CONFLICT", "CART_INVENTORY_UNAVAILABLE",
  "CART_MUTATION_UNCERTAIN", "CART_UNAVAILABLE",
];
function cartCode(value: unknown): CartErrorCode | undefined {
  return typeof value === "string" && cartCodes.some((code) => code === value)
    ? cartCodes.find((code) => code === value)
    : undefined;
}

export function createCartClient(baseUrl: string, publishableKey: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new CartError("unavailable", "Invalid cart configuration.", 0);
  }
  const uncertain = (status: number) => new CartError("uncertain",
    "We could not confirm the final cart state. Reload your cart before trying again.",
    status, "CART_MUTATION_UNCERTAIN");
  async function request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method,
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(30000),
        headers: {
          "x-publishable-api-key": publishableKey,
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    } catch {
      // A lost write response cannot establish whether the server committed.
      if (method !== "GET") throw uncertain(0);
      throw new CartError("unavailable", "Cart service is unavailable. Please try again.", 0);
    }
    if (response.ok) {
      try { return await response.json() as T; }
      catch {
        if (method !== "GET") throw uncertain(response.status);
        throw new CartError("unavailable", "Cart service is unavailable. Please try again.", response.status);
      }
    }
    let body: ErrorBody = {};
    try {
      const value: unknown = await response.json();
      if (typeof value === "object" && value !== null && "code" in value) body = { code: value.code };
    } catch { /* Never expose upstream bodies. */ }
    const code = cartCode(body.code);
    if (response.status === 401) throw new CartError("unauthorized", "Please sign in again.", 401);
    if (response.status === 409 && code === "CART_MERCHANT_CONFLICT") {
      throw new CartError("conflict", "Your cart belongs to another store.", 409, code);
    }
    if (response.status === 409) {
      throw new CartError("validation",
        code === "CART_INVENTORY_UNAVAILABLE" ? "That quantity is no longer available." : "Your cart changed. Refresh it and try again.",
        409, code);
    }
    if (code === "CART_MUTATION_UNCERTAIN") {
      throw new CartError("uncertain", "We could not confirm that change. Reload your cart before trying again.", response.status, code);
    }
    if (response.status === 400 || response.status === 404) {
      throw new CartError("validation", "This cart, product or quantity is no longer available.", response.status, code);
    }
    if (method !== "GET" && response.status >= 500 && code !== "CART_UNAVAILABLE") {
      throw uncertain(response.status);
    }
    throw new CartError("unavailable", "Cart service is unavailable. Please try again.", response.status, code);
  }
  async function refresh(result: CartMutationResult) {
    try {
      if (!result || typeof result.cart_id !== "string" || !/^cart_[a-zA-Z0-9_-]{1,100}$/.test(result.cart_id)) {
        throw uncertain(200);
      }
      const url = new URL("/store/gospaza/cart", base);
      url.searchParams.set("cart_id", result.cart_id);
      return await request<CartFoundation>(url.pathname + url.search);
    } catch (error) {
      // The write already succeeded; never describe a failed follow-up read as
      // permission to replay a non-idempotent mutation.
      throw uncertain(error instanceof CartError ? error.status : 0);
    }
  }
  return {
    current(cartId?: string) {
      const url = new URL("/store/gospaza/cart", base);
      if (cartId) url.searchParams.set("cart_id", cartId);
      return request<CartFoundation>(url.pathname + url.search);
    },
    async add(input: AddCartItemInput) {
      return refresh(await request<CartMutationResult>("/store/gospaza/cart/items", "POST", input));
    },
    async update(lineItemId: string, input: UpdateCartItemInput) {
      return refresh(await request<CartMutationResult>(
        "/store/gospaza/cart/items/" + encodeURIComponent(lineItemId), "PATCH", input));
    },
    async remove(lineItemId: string, cartId: string) {
      return refresh(await request<CartMutationResult>(
        "/store/gospaza/cart/items/" + encodeURIComponent(lineItemId), "DELETE", { cart_id: cartId }));
    },
    async switchStore(input: SwitchCartStoreInput) {
      return refresh(await request<CartMutationResult>("/store/gospaza/cart/switch-store", "POST", input));
    },
  };
}
export type CartClient = ReturnType<typeof createCartClient>;
