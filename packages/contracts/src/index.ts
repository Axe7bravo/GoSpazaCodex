export interface LivenessResponse { status: "ok" }
export type ActorType = "customer" | "merchant" | "driver" | "user";
export interface ActorIdentity { type: ActorType; id: string }
export interface CustomerAccount { id: string; email: string; first_name: string | null; last_name: string | null }


export * from "./applications";

export * from "./catalogue";

export * from "./location";

export * from "./storefront";

export * from "./cart";

export * from "./delivery";

export * from "./checkout";
