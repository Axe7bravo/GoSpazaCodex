import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "pg";
import { loadEnv } from "@medusajs/framework/utils";

// Synchronization only. No business data leaves this fixture: browser checks
// use authenticated HTTP/DOM exclusively. Rollback releases the row lock.
export async function holdFinancialFixtureStock(levelId:string) {
  assert.equal(process.env.APP_ENV,"test");
  assert.equal(process.env.M18_C2B_RETAIN_FINANCIAL_FIXTURES,"true");
  assert.match(levelId,/^[a-zA-Z0-9_-]+$/);
  loadEnv(process.env.NODE_ENV || "development",resolve("apps/backend"));
  const url=process.env.DATABASE_URL;assert.ok(url);
  const client=new Client({connectionString:url});
  await client.connect();
  try {
    await client.query("begin");
    const lock=await client.query("select 1 from inventory_level where id=$1 and deleted_at is null for update",[levelId]);
    assert.equal(lock.rowCount,1,"the isolated fixture's stock level must exist in the selected test database");
  } catch(error) {await client.end();throw error;}
  return async()=>{try {await client.query("rollback");} finally {await client.end();}};
}
