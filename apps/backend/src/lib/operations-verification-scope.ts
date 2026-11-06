import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http";
const schema = process.env.M23_VERIFICATION_SCHEMA, run = process.env.M23_VERIFICATION_RUN;
function guard() {
  if (process.env.APP_ENV !== "test" || process.env.NODE_ENV !== "test" || !new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test")
    || new URL(process.env.REDIS_URL ?? "").pathname !== "/1" || !schema || !/^m23_b_[a-f0-9]{32}$/.test(schema) || schema !== "m23_b_" + run)
    throw Error("Invalid isolated operations verification selection.");
}
if (schema) guard();
let db: Knex | undefined;
// Selected by the owned test backend's environment only. No request/header
// selects grants or a schema. Native identities and sessions remain public.
export async function operationsVerificationScope(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (!schema) { next(); return; }
  try {
    guard(); db ??= knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema, "public"], pool: { min: 0, max: 8 } });
    if (!await db("m23_verification_marker").withSchema(schema).where({ run }).first()) throw Error("Selection mismatch.");
    req.scope.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(db) });
    res.setHeader("X-GoSpaza-M23-Run", run ?? ""); next();
  } catch { res.status(503).json({ message: "Selected operations verification context unavailable." }); }
}
