import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http";
import { driverFinanceFixtureSchema } from "../scripts/fixtures/driver-finance-acceptance";
const schema = process.env.M21_ACCEPTANCE_SCHEMA;
if (schema) driverFinanceFixtureSchema(schema);
let pool: Knex | undefined;
// Deployment-selected, test-only input contract. No request/header selects a
// schema; native authentication and public DriverProfile stay authoritative.
export async function driverFinanceAcceptanceScope(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (!schema) { next(); return; }
  try {
    driverFinanceFixtureSchema(schema);
    pool ??= knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema, "public"], pool: { min: 0, max: 8 } });
    if (!await pool("m21_acceptance_marker").withSchema(schema).where({ version: 1 }).first()) throw new Error("Missing M21 acceptance marker.");
    req.scope.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(pool) }); next();
  } catch { res.status(503).json({ message: "Isolated driver finance fixture unavailable." }); }
}
