import type { ProviderWebhookPayload } from "@medusajs/framework/types";

export interface YocoOptions {
  secretKey: string;
  webhookSecret: string;
  successUrl: string;
  cancelUrl: string;
  failureUrl: string;
  allowedReturnOrigins: string[];
}

export interface CheckoutReceipt {
  id: string;
  redirectUrl: string;
  status: "created" | "started" | "processing" | "completed";
  amount: number;
  currency: "ZAR";
  processingMode: "test" | "live";
}

export interface VerifiedPaymentEvent {
  id: string;
  type: "payment.succeeded" | "payment.failed";
  paymentId: string;
  checkoutId: string;
  sessionId?: string;
  operationId: string;
  amount: number;
  currency: "ZAR";
  mode: "test" | "live";
}

export interface RefundReceipt {
  id: string;
  refundId: string;
  status: "succeeded" | "pending";
}

export interface TechnicalRefund {
  id: string;
  idempotencyKey: string;
  paymentId: string;
  amountMinor: number;
  state: "prepared" | "sending" | "uncertain" | "pending" | "succeeded";
  receipt?: RefundReceipt;
  verifiedEventId?: string;
  replayAllowed?: boolean;
}

/** Internal persisted coordination, never a browser DTO or a payment ledger. */
export interface YocoOperation {
  id: string;
  attemptId: string;
  sessionIds: string[];
  canonicalSessionId?: string;
  accountFingerprint: string;
  paymentCollectionId: string;
  cartId: string;
  amountMinor: number;
  currency: "ZAR";
  mode: "test" | "live";
  idempotencyKey: string;
  state: "prepared" | "sending" | "uncertain" | "created" | "mismatch";
  requestJson: string;
  requestFingerprint: string;
  checkoutId?: string;
  terminalRefunded?: boolean;
  checkout?: CheckoutReceipt;
  payment?: VerifiedPaymentEvent;
  technicalRefund?: TechnicalRefund;
}

/**
 * M10-D/E must supply a durable implementation before registering the provider.
 * No in-memory production fallback exists. Records predate external side effects
 * and survive native session deletion. All IDs/keys/amounts are immutable.
 *
 * Claims MUST atomically compare-and-set prepared -> sending and persist the exact
 * request before returning true, in a committed DB transaction. Recovery of a
 * sending/uncertain claim requires an explicit server-side one-use permit. Save methods must reject conflicting IDs
 * and preserve newer verified evidence. Refund identity is unique per payment,
 * independent of transient Medusa refund IDs. Only verified/correlated inbox
 * evidence may populate payment or advance a pending refund to succeeded.
 */
export abstract class YocoOperationStore {
  abstract read(operationId: string): Promise<YocoOperation | null>;
  abstract associateSession(operationId: string, sessionId: string, token: string | undefined): Promise<void>;
  abstract claimAuthorization(operationId: string, sessionId: string): Promise<boolean>;
  abstract claimInitiation(operationId: string, requestJson: string): Promise<boolean>;
  abstract saveCheckout(operationId: string, receipt: CheckoutReceipt): Promise<void>;
  abstract markInitiationUncertain(operationId: string, mismatch?: boolean): Promise<void>;
  abstract claimRefund(operationId: string, refundId: string, requestJson: string): Promise<boolean>;
  abstract saveRefund(operationId: string, refundId: string, receipt: RefundReceipt): Promise<void>;
  abstract markRefundUncertain(operationId: string, refundId: string, mismatch?: boolean): Promise<void>;
}

export type YocoWebhookPayload = ProviderWebhookPayload["payload"];
export type YocoErrorCode =
  | "YOCO_OPERATION_EXPIRED"
  | "YOCO_IDEMPOTENCY_MISMATCH"
  | "YOCO_INVALID_INPUT"
  | "YOCO_OPERATION_REQUIRED"
  | "YOCO_CORRELATION_MISMATCH"
  | "YOCO_RECONFIRM_REQUIRED"
  | "YOCO_INITIATION_UNCERTAIN"
  | "YOCO_STATUS_UNCERTAIN"
  | "YOCO_CAPTURE_UNCONFIRMED"
  | "YOCO_REFUND_NOT_APPROVED"
  | "YOCO_REFUND_PENDING"
  | "YOCO_REFUND_UNCERTAIN"
  | "YOCO_INVALID_WEBHOOK";

export class YocoProviderError extends Error {
  constructor(public readonly code: YocoErrorCode) {
    super(code);
    this.name = "YocoProviderError";
  }
}
