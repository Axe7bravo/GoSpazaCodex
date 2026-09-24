import { defineMiddlewares } from "@medusajs/framework/http";
import { requestLogging } from "../lib/request-logging";

export default defineMiddlewares({
  routes: [{ matcher: /^\/.*/, middlewares: [requestLogging] }],
});
