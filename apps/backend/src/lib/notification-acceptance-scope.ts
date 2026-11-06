import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http";
import { notificationAcceptanceSchema } from "../scripts/fixtures/notification-acceptance";
const schema = process.env.M22_ACCEPTANCE_SCHEMA, run = process.env.M22_ACCEPTANCE_RUN;
if (schema) notificationAcceptanceSchema(schema);
let pool: Knex | undefined;
// Deployment-selected test fixture only. No header, cookie or request parameter
// can select a schema, actor, grant or data source. Native auth stays real.
export async function notificationAcceptanceScope(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (!schema) { next(); return; }
  try {
    notificationAcceptanceSchema(schema);
    pool ??= knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema, "public"], pool: { min: 0, max: 8 } });
    if (!run || !await pool("m22_acceptance_marker").withSchema(schema).where({ run, version: 1 }).first()) throw Error("Fixture selection mismatch.");
    req.scope.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(pool) });
    res.setHeader("X-GoSpaza-M22-Run", run); next();
  } catch { res.status(503).json({ message: "Selected notification acceptance fixture is unavailable." }); }
}
