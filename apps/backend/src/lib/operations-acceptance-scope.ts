import { AsyncLocalStorage } from "node:async_hooks";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http";
import { operationsSchema } from "../scripts/fixtures/operations-acceptance";
import { operationsEvidenceTables } from "../scripts/fixtures/operations-schema";
import { OrderOperationsService } from "./order-operations-service";
import { DispatchService } from "./dispatch-service";
import { FinancialService } from "./financial-service";
const schema = process.env.M23_ACCEPTANCE_SCHEMA, run = process.env.M23_ACCEPTANCE_RUN;
function guard() {
  if (!schema || schema !== "m23_acceptance_" + run) throw Error("M23 acceptance selector mismatch.");
  operationsSchema(schema);
}
interface Observation { sources: Set<string>; forbidden: Set<string>; read: boolean }
const observations = new AsyncLocalStorage<Observation>();
let pool: Knex | undefined;
if (schema) {
  guard();
  // Failure probes only in the environment-selected test backend. The legacy
  // methods themselves are unchanged. A no-op ensure is still forbidden on GET.
  for (const [prototype, method] of [[OrderOperationsService.prototype, "ensure"], [DispatchService.prototype, "ensure"], [DispatchService.prototype, "reconcile"], [FinancialService.prototype, "ensure"]] as const) {
    const target = prototype as unknown as Record<string, (...args: unknown[]) => unknown>, original = target[method];
    if (!original) throw Error("Missing M23 purity probe target.");
    target[method] = function (this: unknown, ...args: unknown[]) {
      const observation = observations.getStore();
      if (observation?.read) { observation.forbidden.add(method); throw Error("Mutating owner primitive entered operations GET."); }
      return Reflect.apply(original, this, args);
    };
  }
}
// Deployment environment selects the fixture, never a request parameter,
// header, browser value or actor. Native modules/auth are never substituted.
export async function operationsAcceptanceScope(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (!schema) { next(); return; }
  try {
    guard();
    if (!pool) {
      pool = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema, "public"], pool: { min: 0, max: 12 } });
      pool.on("query", (query: { sql: string }) => {
        const observation = observations.getStore(); if (!observation) return;
        for (const table of operationsEvidenceTables) if (query.sql.includes('"' + table + '"') || new RegExp("\\b" + table + "\\b").test(query.sql)) observation.sources.add(table);
      });
    }
    if (!await pool("m23_acceptance_marker").withSchema(schema).where({ run, version: 1 }).first()) throw Error("M23 marker missing.");
    req.scope.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(pool) });
    const observation: Observation = { sources: new Set(), forbidden: new Set(), read: req.method === "GET" && req.originalUrl.startsWith("/admin/gospaza/operations") };
    res.setHeader("X-GoSpaza-M23-Run", run ?? "");
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      res.setHeader("X-GoSpaza-M23-Sources", [...observation.sources].sort().join(","));
      res.setHeader("X-GoSpaza-M23-Forbidden-Reads", String(observation.forbidden.size));
      return json(body);
    }) as typeof res.json;
    observations.run(observation, () => next());
  } catch { res.status(503).json({ message: "Selected operations acceptance context unavailable." }); }
}
