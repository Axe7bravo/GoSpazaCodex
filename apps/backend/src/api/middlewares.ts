import { driverBoundary, strictDriverRegistration } from "../lib/driver-auth";
import { notificationAcceptanceScope } from "../lib/notification-acceptance-scope";
import { blockNativeNotifications, nativeNotificationMatcher } from "../lib/notification-http-boundary";
import { operationsVerificationScope } from "../lib/operations-verification-scope";
import { operationsAcceptanceScope } from "../lib/operations-acceptance-scope";
import { settlementAcceptanceScope } from "../lib/settlement-acceptance-scope";
import { driverFinanceAcceptanceScope } from "../lib/driver-finance-acceptance-scope";
import { blockNativeDelivery } from "../lib/pickup-http";
import { blockNativePayments } from "../lib/checkout-http";
import { blockNativeShipping } from "../lib/scheduling-http";
import { blockNativeCarts } from "../lib/cart-http";
import { guardEmailPassRegistration } from "../lib/registration-guard";
import { defineMiddlewares } from "@medusajs/framework/http";
import { requestLogging } from "../lib/request-logging";
import { authRateLimit, validateEmailPass } from "../lib/auth-rate-limit";
import { merchantBoundary } from "../lib/applicant-auth";
import { requireActor } from "../lib/auth-policy";
import { actorCors, authOrigin, publicRegistrationActors, rotateSession } from "../lib/auth-http";

export default defineMiddlewares({
  routes: [
    { matcher: "/hooks/gospaza/resend", method: "POST", bodyParser: { preserveRawBody: true, sizeLimit: "64kb" } },
    { matcher: nativeNotificationMatcher, middlewares: [blockNativeNotifications] },
    { matcher: /^\/admin\/gospaza\/merchant-payouts(?:\/.*)?$/i, bodyParser: { sizeLimit: "8kb" } },
    { matcher: /^\/admin\/gospaza\/(?:merchant-settlements|settlement-period-policy)(?:\/.*)?$/i, bodyParser: { sizeLimit: "8kb" } },
    { matcher: /^\/admin\/returns(?:\/.*)?$/i, method: ["POST","DELETE"], middlewares: [authOrigin, requireActor("user"), blockNativeDelivery] },
    { matcher: /^\/merchant\/deliveries\/[^/]+\/dispositions$/i, bodyParser: { sizeLimit: "4kb" } },
    // Native financial mutation routes cannot bypass adjustment eligibility,
    // explicit execution capability, or C1's one-settlement reservation.
    { matcher: /^\/admin\/payments\/[^/]+\/refund\/?$/i, method: "POST", middlewares: [authOrigin, requireActor("user"), blockNativePayments] },
    { matcher: /^\/admin\/gospaza\/(?:financial-adjustments|orders\/[^/]+\/(?:goodwill|financial-resolution))(?:\/.*)?$/i, bodyParser: { sizeLimit: "8kb" } },
    { matcher: "/admin/gospaza/commission-rules", method: "POST", bodyParser: { sizeLimit: "8kb" } },
    { matcher: /^\/admin\/gospaza\/driver-compensation(?:\/.*)?$/i, bodyParser: { sizeLimit: "8kb" } },
    { matcher: /^\/admin\/gospaza\/driver-payments(?:\/.*)?$/i, bodyParser: { sizeLimit: "16kb" } },
    { matcher: "/merchant/restricted-commerce/documents", method: "POST", bodyParser: { sizeLimit: "14mb" } },
    { matcher: /^\/driver\/deliveries(?:\/.*)?$/i, bodyParser: { sizeLimit: "8kb" } },
    { matcher: /^\/merchant\/deliveries\/[^/]+\/return$/i, bodyParser: { sizeLimit: "8kb" } },
    { matcher: /^\/store\/gospaza\/orders\/[^/]+\/handoff-code(?:\/regenerate)?$/i, bodyParser: { sizeLimit: "8kb" } },
    { matcher: /^\/admin\/orders\/[^/]+\/(?:fulfillments|cancel)(?:\/.*)?$/i, method: ["POST","DELETE"], middlewares: [authOrigin, requireActor("user"), blockNativeDelivery] },
    { matcher: /^\/admin\/fulfillments(?:\/.*)?$/i, method: ["POST","DELETE"], middlewares: [authOrigin, requireActor("user"), blockNativeDelivery] },
    { matcher: /^\/driver\/(?:availability|location|offers)(?:\/.*)?$/i, bodyParser: { sizeLimit: "8kb" } },
    { matcher: "/hooks/gospaza/yoco", method: "POST", bodyParser: { preserveRawBody: true, sizeLimit: "64kb" } },
    { matcher: /^\/store\/payment-collections(?:\/.*)?$/i, middlewares: [blockNativePayments] },
    // A partial native Order is not a verified GoSpaza checkout outcome.
    { matcher: /^\/store\/orders(?:\/.*)?$/i, middlewares: [blockNativePayments] },
    { matcher: /^\/hooks\/payment(?:\/.*)?$/i, middlewares: [blockNativePayments] },
    { matcher: /^\/store\/shipping-options(?:\/.*)?$/i, middlewares: [blockNativeShipping] },
    { matcher: /^\/store\/carts(?:\/.*)?$/i, middlewares: [blockNativeCarts] },
    { matcher: "/merchant/products/:id/images", method: "POST", bodyParser: { sizeLimit: "8mb" } },
    { matcher: "/merchant/applications/:id/documents", method: "POST", bodyParser: { sizeLimit: "14mb" } },
    { matcher: /^\/.*/, middlewares: [requestLogging] },
    { matcher: /^\/auth(?:\/.*)?$/i, middlewares: [authOrigin] },
    { matcher: /^\/auth\/[^/]+\/emailpass(?:\/register)?\/?$/i, method: ["POST", "GET"], middlewares: [authRateLimit, validateEmailPass] },
    { matcher: "/store/customers", method: "POST", middlewares: [authOrigin] },
    { matcher: "/auth/:actor_type/:auth_provider/register", method: "POST", middlewares: [publicRegistrationActors, strictDriverRegistration, guardEmailPassRegistration] },
    { matcher: "/auth/session", method: "POST", middlewares: [rotateSession] },
    { matcher: /^\/store\/gospaza(?:\/.*)?$/i, middlewares: [authOrigin, requireActor("customer")] },
    { matcher: /^\/merchant(?:\/.*)?$/i, middlewares: [actorCors, authOrigin, merchantBoundary] },
    { matcher: /^\/driver(?:\/.*)?$/i, middlewares: [actorCors, authOrigin, driverBoundary] },
    { matcher: /^\/admin\/gospaza(?:\/.*)?$/i, middlewares: [authOrigin, requireActor("user")] },
    { matcher: /^\/(?:admin\/gospaza\/(?:merchant-settlements|merchant-payouts|settlement-period-policy)|merchant\/settlements)(?:\/.*)?$/i, middlewares: [settlementAcceptanceScope] },
    { matcher: /^\/(?:admin\/gospaza\/(?:driver-finance|driver-payments|driver-compensation|driver-earnings)|driver\/earnings)(?:\/.*)?$/i, middlewares: [driverFinanceAcceptanceScope] },
    { matcher: /^\/(?:health\/live|store\/gospaza\/notifications(?:\/.*)?|merchant\/notifications(?:\/.*)?|driver\/(?:notifications|offers|dispatch|availability|deliveries)(?:\/.*)?|admin\/gospaza\/(?:notifications|notification-operations)(?:\/.*)?)$/i, middlewares: [notificationAcceptanceScope] },
    { matcher: /^\/(?:health\/live|admin\/gospaza\/(?:operations|drivers|service-zones|scheduling|stores)(?:\/.*)?)$/i, middlewares: [operationsVerificationScope] },
    { matcher: /^\/(?:health\/live|admin\/gospaza\/(?:operations|merchant-applications|drivers|service-zones|scheduling|stores)(?:\/.*)?|driver\/offers(?:\/.*)?)$/i, middlewares: [operationsAcceptanceScope] },
  ],
});

