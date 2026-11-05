import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { isolatedEnvironment } from "./isolated-verifier";
import type { SettlementAcceptance } from "../src/scripts/fixtures/settlement-acceptance";
const backend=resolve(__dirname,"..");
const {env,summary}=isolatedEnvironment(parseEnv(readFileSync(resolve(backend,".env"),"utf8")),process.env);
if(!env.M20_BROWSER_MANIFEST) env.M20_BROWSER_MANIFEST=readFileSync(resolve(backend,"../../test-results/m20-current-manifest.txt"),"utf8").trim();
if(!env.M20_BROWSER_MANIFEST) throw new Error("Select a freshly generated M20_BROWSER_MANIFEST.");
const manifest=JSON.parse(readFileSync(resolve(env.M20_BROWSER_MANIFEST),"utf8")) as SettlementAcceptance;
if(manifest.version!==1 || !/^m20_acceptance_[a-f0-9]{32}$/.test(manifest.schema)) throw new Error("Invalid M20 fixture manifest.");
env.M20_ACCEPTANCE_SCHEMA=manifest.schema;
const a=manifest.actors;
Object.assign(env,{SETTLEMENT_VIEW_USER_IDS:[a.operator.id,a.viewer.id].join(","),
  SETTLEMENT_PREPARE_USER_IDS:[a.operator.id,a.preparer.id].join(","),SETTLEMENT_APPROVE_USER_IDS:[a.operator.id,a.approver.id].join(","),
  SETTLEMENT_PAYOUT_RECORD_USER_IDS:[a.operator.id,a.recorder.id].join(","),SETTLEMENT_RECONCILE_USER_IDS:[a.operator.id,a.reconciler.id].join(",")});
delete env.M20_VERIFY_SECRET; // Native auth verifies persisted password hashes; server needs no fixture password seed.
console.log("M20 isolated built backend:",summary);
const child=spawnSync(process.execPath,[require.resolve("@medusajs/cli/cli.js"),"start"],{cwd:resolve(backend,".medusa/server"),env,stdio:"inherit"});
if(child.error) throw child.error;
process.exitCode=child.status??1;
