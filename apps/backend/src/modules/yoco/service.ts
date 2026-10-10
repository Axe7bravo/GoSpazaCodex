// Adapted from medusa-payment-yoco 0513eda8db1adcf00bcf1806c436954ab9134f69; see LICENSE.
import { AbstractPaymentProvider } from "@medusajs/framework/utils";
import type {
  InitiatePaymentInput, InitiatePaymentOutput, UpdatePaymentInput, UpdatePaymentOutput,
  AuthorizePaymentInput, AuthorizePaymentOutput, CapturePaymentInput, CapturePaymentOutput,
  RefundPaymentInput, RefundPaymentOutput, CancelPaymentInput, CancelPaymentOutput,
  DeletePaymentInput, DeletePaymentOutput, RetrievePaymentInput, RetrievePaymentOutput,
  GetPaymentStatusInput, GetPaymentStatusOutput, WebhookActionResult, PaymentProviderInput,
} from "@medusajs/framework/types";
import { nativePrice } from "../marketplace/catalogue-policy";
import { cents, checkoutReceipt, refundReceipt, hostedRedirect, identifier, options } from "./validation";
import { fingerprint, requestSchema } from "./request";
import { verifyYocoEvent } from "./webhook";
import {
  YocoOperationStore, YocoProviderError, type YocoOptions, type YocoOperation,
  type VerifiedPaymentEvent, type YocoWebhookPayload,
} from "./types";

const YOCO_API = "https://payments.yoco.com/api";

export default class YocoPaymentService extends AbstractPaymentProvider<YocoOptions> {
  static identifier = "yoco";
  private readonly configuration: YocoOptions;
  private readonly operations: YocoOperationStore;

  constructor(container: Record<string, unknown>, configuration: YocoOptions) {
    super(container, configuration);
    this.configuration = options(configuration);
    if (!(container.yocoOperations instanceof YocoOperationStore)) {
      throw new YocoProviderError("YOCO_OPERATION_REQUIRED");
    }
    this.operations = container.yocoOperations;
  }

  private async operation(input: PaymentProviderInput, associate = false): Promise<YocoOperation & { sessionId: string }> {
    const operationId = identifier.safeParse(input.data?.operation_id);
    const sessionId = identifier.safeParse(input.data?.session_id);
    if (!operationId.success || !sessionId.success) throw new YocoProviderError("YOCO_OPERATION_REQUIRED");
    if (associate) await this.operations.associateSession(operationId.data, sessionId.data,
      typeof input.data?.session_token === "string" ? input.data.session_token : undefined);
    const operation = await this.operations.read(operationId.data);
    if (!operation || operation.id !== operationId.data || !operation.sessionIds.includes(sessionId.data)) {
      throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    }
    const mode = this.configuration.secretKey.startsWith("sk_live_") ? "live" : "test";
    if (operation.accountFingerprint !== fingerprint(this.configuration.secretKey)
      || operation.mode !== mode || operation.currency !== "ZAR"
      || !Number.isSafeInteger(operation.amountMinor) || operation.amountMinor < 200
      || !identifier.safeParse(operation.idempotencyKey).success) {
      throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    }
    if (input.data?.yocoCheckoutId !== undefined && input.data.yocoCheckoutId !== (operation.checkoutId ?? operation.checkout?.id)) {
      throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    }
    return { ...operation, sessionId: sessionId.data };
  }

  private data(operation: YocoOperation & { sessionId: string }): Record<string, unknown> {
    // Deliberate allowlist: never echo arbitrary input data or secrets.
    return {
      operation_id: operation.id,
      attempt_id: operation.attemptId,
      session_id: operation.sessionId,
      payment_collection_id: operation.paymentCollectionId,
      cart_id: operation.cartId,
      yocoCheckoutId: operation.checkoutId ?? operation.checkout?.id,
      redirectUrl: operation.checkout?.redirectUrl,
      yocoPaymentId: operation.payment?.paymentId,
    };
  }

  private correlate(operation: YocoOperation, event: VerifiedPaymentEvent): void {
    if (event.operationId !== operation.id || (event.sessionId !== undefined && !operation.sessionIds.includes(event.sessionId))
      || event.checkoutId !== (operation.checkoutId ?? operation.checkout?.id) || event.amount !== operation.amountMinor
      || event.currency !== operation.currency || event.mode !== operation.mode
      || (operation.payment?.type === "payment.succeeded" && operation.payment.paymentId !== event.paymentId)) {
      throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    }
  }

  private status(operation: YocoOperation): GetPaymentStatusOutput["status"] {
    if (operation.payment) {
      this.correlate(operation, operation.payment);
      return operation.payment.type === "payment.succeeded" ? "captured" : "error";
    }
    if (!operation.checkout || operation.state !== "created" || operation.checkout.status === "completed") {
      throw new YocoProviderError("YOCO_STATUS_UNCERTAIN");
    }
    // Awaiting verified evidence after a confirmed checkout creation. No GET guess
    // and no conversion of transport errors into a successful pending result.
    return "pending";
  }

  private async post(path: string, requestJson: string, key: string): Promise<unknown> {
    const response = await fetch(YOCO_API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.configuration.secretKey, "Idempotency-Key": key },
      body: requestJson,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    // Never log/echo provider errors. A transport/HTTP/parse failure after sending
    // is conservatively uncertain and must be reconciled by the operation owner.
    if (response.status === 422) throw new YocoProviderError("YOCO_IDEMPOTENCY_MISMATCH");
    if (!response.ok) throw new Error("Yoco request was not confirmed.");
    const body: unknown = await response.json();
    return body;
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    let operation = await this.operation(input, true);
    if (operation.terminalRefunded || operation.technicalRefund?.state === "succeeded"
      || operation.state === "mismatch") throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    const amount = cents(input.amount, input.currency_code);
    if (amount !== operation.amountMinor) throw new YocoProviderError("YOCO_RECONFIRM_REQUIRED");
    const requestJson = operation.requestJson;
    const parsed = requestSchema.safeParse(JSON.parse(requestJson));
    if (!parsed.success || fingerprint(requestJson) !== operation.requestFingerprint
      || parsed.data.amount !== amount || parsed.data.externalId !== operation.id
      || parsed.data.metadata.operation_id !== operation.id || parsed.data.metadata.attempt_id !== operation.attemptId
      || parsed.data.metadata.session_id !== undefined && !operation.sessionIds.includes(parsed.data.metadata.session_id)) {
      throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    }
    // Validate frozen return URLs against today's allowlist without rewriting
    // them from today's defaults. New defaults apply only to new operations.
    options({ ...this.configuration, successUrl: parsed.data.successUrl,
      cancelUrl: parsed.data.cancelUrl, failureUrl: parsed.data.failureUrl });
    if (operation.payment) {
      this.correlate(operation, operation.payment);
      if (operation.payment.type !== "payment.succeeded") throw new YocoProviderError("YOCO_STATUS_UNCERTAIN");
      return { id: operation.payment.checkoutId, status: "captured", data: this.data(operation) };
    }
    if (!operation.checkout) {
      if (!await this.operations.claimInitiation(operation.id, requestJson)) {
        operation = await this.operation(input);
        if (!operation.checkout || operation.requestJson !== requestJson) {
          throw new YocoProviderError("YOCO_INITIATION_UNCERTAIN");
        }
      } else {
        try {
          const receipt = checkoutReceipt.parse(await this.post("/checkouts", requestJson, operation.idempotencyKey));
          hostedRedirect(receipt.redirectUrl);
          if (receipt.amount !== amount || receipt.currency !== operation.currency || receipt.processingMode !== operation.mode) {
            throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
          }
          await this.operations.saveCheckout(operation.id, receipt);
        } catch (error) {
          const mismatch = error instanceof YocoProviderError && error.code === "YOCO_IDEMPOTENCY_MISMATCH";
          await this.operations.markInitiationUncertain(operation.id, mismatch);
          throw new YocoProviderError(mismatch ? "YOCO_IDEMPOTENCY_MISMATCH" : "YOCO_INITIATION_UNCERTAIN");
        }
        operation = await this.operation(input);
      }
    }
    if (!operation.checkout) throw new YocoProviderError("YOCO_INITIATION_UNCERTAIN");
    // Initiation cannot authorize a payment/order. Reconciliation owns that step.
    return { id: operation.checkout.id, status: "pending", data: this.data(operation) };
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const operation = await this.operation(input);
    if (operation.terminalRefunded) throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    if (cents(input.amount, input.currency_code) !== operation.amountMinor) {
      throw new YocoProviderError("YOCO_RECONFIRM_REQUIRED");
    }
    // Never call the checkout API here, including during native compensation.
    return { status: this.status(operation), data: this.data(operation) };
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const operation = await this.operation(input);
    return { status: this.status(operation) };
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const operation = await this.operation(input);
    const status = this.status(operation);
    if (status === "captured" && !await this.operations.claimAuthorization(operation.id, operation.sessionId)) {
      throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    }
    return { status, data: this.data(operation) };
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const operation = await this.operation(input);
    if (this.status(operation) !== "captured") throw new YocoProviderError("YOCO_CAPTURE_UNCONFIRMED");
    if (!await this.operations.claimAuthorization(operation.id, operation.sessionId)) throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    return { data: this.data(operation) };
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const operation = await this.operation(input);
    return { data: { ...this.data(operation), status: this.status(operation) } };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    let operation = await this.operation(input);
    if (this.status(operation) !== "captured") throw new YocoProviderError("YOCO_CAPTURE_UNCONFIRMED");
    const refund = operation.technicalRefund;
    const checkoutId = operation.checkoutId ?? operation.checkout?.id;
    const amount = cents(input.amount, operation.currency);
    if (!refund || refund.amountMinor !== amount || amount !== operation.amountMinor
      || refund.paymentId !== operation.payment?.paymentId
      || !identifier.safeParse(refund.idempotencyKey).success || !checkoutId) {
      throw new YocoProviderError("YOCO_REFUND_NOT_APPROVED");
    }
    if ((refund.state === "prepared" || refund.replayAllowed) && await this.operations.claimRefund(operation.id, refund.id, JSON.stringify({ amount }))) {
      try {
        const receipt = refundReceipt.parse(await this.post(
          "/checkouts/" + encodeURIComponent(checkoutId) + "/refund",
          JSON.stringify({ amount }), refund.idempotencyKey,
        ));
        if (receipt.id !== checkoutId) throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
        await this.operations.saveRefund(operation.id, refund.id, receipt);
      } catch (error) {
        await this.operations.markRefundUncertain(operation.id, refund.id, error instanceof YocoProviderError && error.code === "YOCO_IDEMPOTENCY_MISMATCH");
        throw new YocoProviderError("YOCO_REFUND_UNCERTAIN");
      }
    }
    operation = await this.operation(input);
    const current = operation.technicalRefund;
    if (current?.state === "pending") throw new YocoProviderError("YOCO_REFUND_PENDING");
    if (!current || current.id !== refund.id || current.idempotencyKey !== refund.idempotencyKey
      || current.paymentId !== refund.paymentId || current.amountMinor !== amount
      || current.state !== "succeeded"
      || !current.verifiedEventId && (current.receipt?.status !== "succeeded" || current.receipt.id !== checkoutId)) {
      throw new YocoProviderError("YOCO_REFUND_UNCERTAIN");
    }
    return { data: { ...this.data(operation), yocoRefundId: current.receipt?.refundId, yocoRefundEventId: current.verifiedEventId } };
  }

  async cancelPayment(_input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    // No supported remote cancellation was established. Never tell Medusa that
    // a still-payable external checkout was cancelled; orchestration must recover.
    throw new YocoProviderError("YOCO_STATUS_UNCERTAIN");
  }

  async deletePayment(_input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    // Native cleanup may delete its session. Durable external correlation survives.
    // This does not cancel or delete the hosted checkout or the operation record.
    return {};
  }

  async getWebhookActionAndData(input: YocoWebhookPayload): Promise<WebhookActionResult> {
    const event = verifyYocoEvent(input, this.configuration.webhookSecret);
    if (!event) return { action: "not_supported" };
    const stored = await this.operations.read(event.operationId);
    if (!stored) throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    if (!stored.canonicalSessionId) throw new YocoProviderError("YOCO_STATUS_UNCERTAIN");
    const operation = await this.operation({ data: { operation_id: event.operationId, session_id: stored.canonicalSessionId } });
    this.correlate(operation, event);
    return {
      action: event.type === "payment.succeeded" ? "captured" : "failed",
      data: { session_id: operation.sessionId, amount: nativePrice(event.amount) },
    };
  }
}
