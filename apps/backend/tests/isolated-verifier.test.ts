import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isolatedEnvironment, verifierPath } from "../scripts/isolated-verifier";

const file={DATABASE_URL:"postgres://user:pg-secret@localhost:5432/gospaza?sslmode=disable",
  REDIS_URL:"rediss://user:redis-secret@localhost:6380/4",BACKEND_URL:"http://localhost:9000",
  JWT_SECRET:"file-jwt",COOKIE_SECRET:"file-cookie",APP_ENV:"development",NODE_ENV:"production"};

test("isolated verifier derives the sibling database and forces both workers off in the child only",()=>{
  const parent={REFUND_RECOVERY_WORKER_ENABLED:"true",PAYMENT_RECONCILIATION_WORKER_ENABLED:"true",
    JWT_SECRET:"parent-jwt",M18_C2B_RETAIN_FINANCIAL_FIXTURES:"true"};
  const {env,summary}=isolatedEnvironment(file,parent);
  assert.equal(env.DATABASE_URL,file.DATABASE_URL.replace("gospaza?","gospaza_test?"));
  assert.equal(env.REDIS_URL,file.REDIS_URL.replace("/4","/1"));
  assert.equal(env.JWT_SECRET,parent.JWT_SECRET);
  assert.equal(env.COOKIE_SECRET,file.COOKIE_SECRET);
  assert.equal(env.M18_C2B_RETAIN_FINANCIAL_FIXTURES,"true");
  assert.equal(env.APP_ENV,"test");assert.equal(env.NODE_ENV,"test");
  assert.equal(env.REFUND_RECOVERY_WORKER_ENABLED,"false");assert.equal(env.PAYMENT_RECONCILIATION_WORKER_ENABLED,"false");
  assert.equal(parent.REFUND_RECOVERY_WORKER_ENABLED,"true");assert.equal(file.APP_ENV,"development");
  assert.equal(summary.database,"gospaza_test");assert.equal(summary.redis_database,1);
  assert.equal(summary.secrets.JWT_SECRET,"present");assert.equal(summary.secrets.HANDOFF_OTP_SECRET,"missing");
  for(const privateValue of ["pg-secret","redis-secret","parent-jwt","file-cookie","localhost","postgres://"])
    assert.equal(JSON.stringify(summary).includes(privateValue),false);
});

test("explicit database must be isolated; connection parameters cannot redirect isolation",()=>{
  assert.throws(()=>isolatedEnvironment(file,{DATABASE_URL:file.DATABASE_URL}),/_test/);
  const isolated="postgresql://localhost/another_test";
  assert.equal(isolatedEnvironment(file,{DATABASE_URL:isolated}).env.DATABASE_URL,isolated);
  assert.equal(isolatedEnvironment({...file,DATABASE_URL:isolated},{}).summary.database,"another_test");
  for(const target of [isolated+"?dbname=prod",isolated+"?database=prod","postgres://localhost/prod%2F_test"])
    assert.throws(()=>isolatedEnvironment(file,{DATABASE_URL:target}));
  assert.throws(()=>isolatedEnvironment(file,{REDIS_URL:"redis://localhost/1?db=0"}));
  assert.throws(()=>isolatedEnvironment(file,{BACKEND_URL:"https://production.example"}),/loopback/);
  assert.equal(isolatedEnvironment(file,{REDIS_URL:"redis://localhost"}).env.REDIS_URL,"redis://localhost/1");
});

test("only one declared Medusa verification script can be executed",()=>{
  const scripts={"test:example":"medusa exec ./src/scripts/verify-example.ts","test:unsafe":"medusa develop"};
  for(const args of [["test:example"],["--","test:example"]])
    assert.equal(verifierPath(args,scripts),"./src/scripts/verify-example.ts");
  for(const args of [[],["dev"],["test:unsafe"],["test:unknown"],["test:example","extra"],["test:example;echo"]])
    assert.throws(()=>verifierPath(args,scripts));
});

test("M21 fixture registration satisfies the unchanged isolated-verifier admission contract",()=>{
  const scripts=JSON.parse(readFileSync(resolve(__dirname,"../package.json"),"utf8")).scripts;
  assert.equal(verifierPath(["--","test:driver-finance-fixtures"],scripts),"./src/scripts/verify-driver-finance-fixtures.ts");
  assert.throws(()=>verifierPath(["test:driver-finance-fixtures"],{
    ...scripts,"test:driver-finance-fixtures":"medusa exec ./src/scripts/prepare-driver-finance.ts",
  }));
});
