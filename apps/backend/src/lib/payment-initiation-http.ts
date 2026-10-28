import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { initiateCheckoutPaymentWorkflow } from "../workflows/initiate-checkout-payment";
import { RestrictedCommerce } from "./restricted-commerce";

export const paymentInitiationHandler = (recover: boolean) => async (req: MedusaRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control", "private, no-store");
  const actor = (req as AuthenticatedMedusaRequest).auth_context;
  if (actor?.actor_type !== "customer" || !actor.actor_id) {
    res.status(401).json({ message: "Sign in required." }); return;
  }
  if (Object.keys(req.query).length) {
    res.status(400).json({ code: "CHECKOUT_INPUT_INVALID", message: "Unexpected payment query." }); return;
  }
  try {
    const { result } = await initiateCheckoutPaymentWorkflow(req.scope).run({
      input: { customerId: actor.actor_id, body: req.body, recover },
    });
    res.status(result.state === "expired" ? 409 : result.state === "uncertain" ? 503 : 200).json(result);
  } catch (error) {
    if (typeof error === "object" && error !== null && MedusaError.isMedusaError(error)) {
      if (error.type === MedusaError.Types.INVALID_DATA) {
        res.status(400).json({ code: "CHECKOUT_INPUT_INVALID", message: "Refresh checkout before continuing." }); return;
      }
      if (error.type === MedusaError.Types.NOT_FOUND) {
        res.status(404).json({ code: "CHECKOUT_UNAVAILABLE", message: "Checkout unavailable." }); return;
      }
      if (error.type === MedusaError.Types.CONFLICT) {
        await new RestrictedCommerce(req.scope).blocked(actor.actor_id,error.message);
        if (["PURCHASER_VERIFICATION_UNAVAILABLE", "PURCHASER_VERIFICATION_NOT_VERIFIED", "PURCHASER_VERIFICATION_EXPIRED",
          "CLASSIFICATION_REVIEW_REQUIRED", "RESTRICTED_STORE_UNAVAILABLE", "RESTRICTED_CATEGORY_UNAVAILABLE", "RESTRICTED_TRADING_CLOSED"].includes(error.message)) {
          res.status(409).json({ code: error.message, message: "Restricted checkout is unavailable. No new payment has been authorised by this request." }); return;
        }
        res.status(409).json({ code: error.message === "PAYMENT_IDEMPOTENCY_MISMATCH"
          ? "PAYMENT_IDEMPOTENCY_MISMATCH" : "CHECKOUT_REFRESH_REQUIRED",
        message: "Refresh checkout. An existing payment must not be started again with different details." }); return;
      }
    }
    res.status(503).json({ code: "PAYMENT_RECOVERY_REQUIRED",
      message: "Payment could not be confirmed. Refresh before choosing to recover the existing attempt." });
  }
};
