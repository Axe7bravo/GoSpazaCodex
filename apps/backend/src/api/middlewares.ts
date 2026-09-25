import { defineMiddlewares } from "@medusajs/framework/http";
import { requestLogging } from "../lib/request-logging";
import { authRateLimit, validateEmailPass } from "../lib/auth-rate-limit";
import { merchantBoundary } from "../lib/applicant-auth";
import { requireActor } from "../lib/auth-policy";
import { actorCors, authOrigin, publicRegistrationActors, rotateSession } from "../lib/auth-http";

export default defineMiddlewares({
  routes: [
    { matcher: "/merchant/applications/:id/documents", method: "POST", bodyParser: { sizeLimit: "14mb" } },
    { matcher: /^\/.*/, middlewares: [requestLogging] },
    { matcher: /^\/auth(?:\/.*)?$/i, middlewares: [authOrigin] },
    { matcher: /^\/auth\/[^/]+\/emailpass(?:\/register)?\/?$/i, method: ["POST", "GET"], middlewares: [authRateLimit, validateEmailPass] },
    { matcher: "/store/customers", method: "POST", middlewares: [authOrigin] },
    { matcher: "/auth/:actor_type/:auth_provider/register", method: "POST", middlewares: [publicRegistrationActors] },
    { matcher: "/auth/session", method: "POST", middlewares: [rotateSession] },
    { matcher: /^\/store\/gospaza(?:\/.*)?$/i, middlewares: [requireActor("customer")] },
    { matcher: /^\/merchant(?:\/.*)?$/i, middlewares: [actorCors, authOrigin, merchantBoundary] },
    { matcher: /^\/driver(?:\/.*)?$/i, middlewares: [actorCors, requireActor("driver")] },
    { matcher: /^\/admin\/gospaza(?:\/.*)?$/i, middlewares: [requireActor("user")] },
  ],
});

