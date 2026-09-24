import type { ActorType, ActorIdentity, CustomerAccount } from "@gospaza/contracts";

const identityPaths: Record<ActorType, string> = {
  customer: "/store/gospaza/me", merchant: "/merchant/me", driver: "/driver/me", user: "/admin/gospaza/me",
};
export class AuthError extends Error {
  constructor(public readonly kind: "validation" | "credentials" | "unauthorized" | "unavailable" | "unprovisioned" | "configuration", message: string, public readonly status?: number) {
    super(message);
    this.name = "AuthError";
  }
}
export function validateCredentials(email: string, password: string, registration = false): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.trim().length > 254) return "Enter a valid email address.";
  if (!password || password.length > 256) return "Enter a password of at most 256 characters.";
  if (registration && password.length < 12) return "Use at least 12 characters for your password.";
  return null;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
export interface AuthClient {
  readonly actor: ActorType;
  me(): Promise<ActorIdentity>;
  login(email: string, password: string): Promise<ActorIdentity>;
  logout(): Promise<void>;
}
export interface CustomerAuthClient extends AuthClient {
  register(email: string, password: string): Promise<CustomerAccount>;
  account(): Promise<CustomerAccount>;
}
export function createAuthClient(actor: ActorType, options: { baseUrl: string; publishableKey?: string; fetcher?: typeof fetch }): AuthClient {
  const client = buildClient(actor, options);
  return { actor: client.actor, me: client.me, login: client.login, logout: client.logout };
}
export function createCustomerAuthClient(options: { baseUrl: string; publishableKey: string; fetcher?: typeof fetch }): CustomerAuthClient {
  return buildClient("customer", options);
}

function buildClient(actor: ActorType, { baseUrl, publishableKey, fetcher = fetch }: { baseUrl: string; publishableKey?: string; fetcher?: typeof fetch }) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new AuthError("configuration", "Invalid API configuration.");

  async function request(path: string, method = "GET", body?: unknown, token?: string, anonymous = false): Promise<unknown> {
    if (path.startsWith("/store/") && !publishableKey) throw new AuthError("configuration", "Customer access is not configured. Contact support.");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (path.startsWith("/store/")) headers["x-publishable-api-key"] = publishableKey!;
    if (token) headers.Authorization = "Bearer " + token;
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method, headers, credentials: anonymous ? "omit" : "include",
        cache: "no-store", signal: AbortSignal.timeout(15000),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AuthError("unavailable", "We cannot reach GoSpaza right now. Please try again.");
    }
    if (!response.ok) {
      if (response.status === 401) throw new AuthError("unauthorized", "Please sign in again.", 401);
      if (response.status >= 500 || response.status === 429) throw new AuthError("unavailable", "GoSpaza is temporarily unavailable. Please try again shortly.", response.status);
      throw new AuthError("validation", "We could not complete that request. Check your details and try again.", response.status);
    }
    try { return await response.json(); }
    catch { throw new AuthError("unavailable", "GoSpaza returned an unexpected response."); }
  }

  function tokenFrom(value: unknown): string {
    if (!record(value) || typeof value.token !== "string" || value.mfa_required || value.verification_required) {
      throw new AuthError("credentials", "This account requires an authentication step that is not available here.");
    }
    return value.token;
  }
  async function loginToken(email: string, password: string) {
    try { return tokenFrom(await request("/auth/" + actor + "/emailpass", "POST", { email: email.trim(), password }, undefined, true)); }
    catch (error) {
      if (error instanceof AuthError && error.status === 401) throw new AuthError("credentials", "Email or password is incorrect.");
      throw error;
    }
  }
  async function me(): Promise<ActorIdentity> {
    const data = await request(identityPaths[actor]);
    if (!record(data) || !record(data.actor) || data.actor.type !== actor || typeof data.actor.id !== "string" || !data.actor.id) {
      throw new AuthError("unauthorized", "This session cannot access this application.");
    }
    return { type: actor, id: data.actor.id };
  }
  async function logout() {
    try { await request("/auth/session", "DELETE"); }
    catch (error) { if (!(error instanceof AuthError && error.status === 401)) throw error; }
  }
  async function login(email: string, password: string) {
    const invalid = validateCredentials(email, password);
    if (invalid) throw new AuthError("validation", invalid);
    if (actor === "customer" && !publishableKey) throw new AuthError("configuration", "Customer access is not configured. Contact support.");
    // Token exists only in this stack frame for Medusa's native session exchange.
    const token = await loginToken(email, password);
    await request("/auth/session", "POST", undefined, token);
    try { return await me(); }
    catch (error) {
      if (error instanceof AuthError && error.kind === "unauthorized") {
        await logout();
        throw new AuthError("unprovisioned", actor === "customer"
          ? "Finish creating your customer account using Register."
          : "This account is not provisioned for this application. Contact your administrator.");
      }
      throw error;
    }
  }
  async function account(): Promise<CustomerAccount> {
    if (actor !== "customer") throw new AuthError("configuration", "Customer client required.");
    const data = await request("/store/customers/me?fields=id,email,first_name,last_name");
    if (!record(data) || !record(data.customer) || typeof data.customer.id !== "string" || typeof data.customer.email !== "string") {
      throw new AuthError("unavailable", "GoSpaza returned an unexpected account response.");
    }
    const customer = data.customer;
    return { id: customer.id as string, email: customer.email as string,
      first_name: typeof customer.first_name === "string" ? customer.first_name : null,
      last_name: typeof customer.last_name === "string" ? customer.last_name : null };
  }
  async function register(email: string, password: string) {
    if (actor !== "customer") throw new AuthError("configuration", "Customer registration only.");
    const invalid = validateCredentials(email, password, true);
    if (invalid) throw new AuthError("validation", invalid);
    if (!publishableKey) throw new AuthError("configuration", "Customer access is not configured. Contact support.");
    let token: string;
    try { token = tokenFrom(await request("/auth/customer/emailpass/register", "POST", { email: email.trim(), password }, undefined, true)); }
    catch (error) {
      if (!(error instanceof AuthError && error.status === 401)) throw error;
      // Medusa can reuse an existing EmailPass identity for another actor, or
      // resume a registration whose identity succeeded but customer creation failed.
      token = await loginToken(email, password);
    }
    try { await request("/store/customers", "POST", { email: email.trim() }, token, true); }
    catch (error) {
      if (error instanceof AuthError && error.status === 400) throw new AuthError("validation", "An account may already exist. Try signing in.");
      throw error;
    }
    // New login reads the customer_id set by createCustomerAccountWorkflow.
    await login(email, password);
    return account();
  }
  return { actor, me, login, logout, register, account };
}
