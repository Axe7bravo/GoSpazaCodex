import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { MedusaRequest,MedusaResponse,MedusaNextFunction } from "@medusajs/framework/http";
import { settlementFixtureSchema } from "../scripts/fixtures/settlement-acceptance";
// No request/header can select a schema. Native auth and tenant resolution stay
// on their configured modules; only explicitly enabled M20 test requests use
// the private input-contract fixture. Production/default requests are untouched.
const schema=process.env.M20_ACCEPTANCE_SCHEMA;
if(schema) settlementFixtureSchema(schema);
let pool:Knex|undefined;
export async function settlementAcceptanceScope(req:MedusaRequest,res:MedusaResponse,next:MedusaNextFunction) {
  if(!schema) {next();return;}
  try {
    settlementFixtureSchema(schema);
    pool??=knex({client:"pg",connection:process.env.DATABASE_URL,searchPath:[schema,"public"],pool:{min:0,max:4}});
    if(!await pool("m20_acceptance_marker").withSchema(schema).where({version:1}).first()) throw new Error("Missing M20 fixture marker.");
    req.scope.register({[ContainerRegistrationKeys.PG_CONNECTION]:asValue(pool)});
    next();
  } catch {res.status(503).json({message:"Isolated settlement fixture is unavailable."});}
}
