import { test,expect,type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHmac,randomUUID } from "node:crypto";
import type { PlatformSettlementDetail,MerchantSettlementDetail } from "@gospaza/contracts";
import type { SettlementAcceptance } from "../../../apps/backend/src/scripts/fixtures/settlement-acceptance";
const f=JSON.parse(readFileSync(process.env.M20_BROWSER_MANIFEST??"","utf8")) as SettlementAcceptance&{api_verified:boolean};
if(f.version!==1||!f.api_verified) throw new Error("M20 API acceptance must pass first.");
const admin="http://localhost:3003",merchant="http://localhost:3001",api="http://localhost:9000";
async function login(page:Page,app:string,email:string) {
  await page.goto(app+"/login");await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password",{exact:true}).fill(createHmac("sha256",process.env.M20_VERIFY_SECRET??"").update(email).digest("hex"));
  await Promise.all([page.waitForURL(url=>url.origin===app&&url.pathname!=="/login"),page.getByRole("button",{name:"Sign in",exact:true}).click()]);
}
async function openPlatform(page:Page,id:string,expected:string) {
  const preflight=await page.request.get(api+"/admin/gospaza/merchant-settlements/"+id);expect(preflight.status()).toBe(200);
  const data=await preflight.json() as PlatformSettlementDetail;
  expect(data.statement.payment_status,"Consumed mutable fixture: generate a fresh manifest rather than replaying this journey.").toBe(expected);
  await Promise.all([page.waitForResponse(r=>r.url()===api+"/admin/gospaza/merchant-settlements/"+id&&r.status()===200),page.goto(admin+"/admin/settlements/"+id)]);
}
async function review(page:Page,label:string) {
  await page.getByLabel("Reason",{exact:true}).fill("M20 browser review of recorded evidence");
  await page.getByRole("checkbox",{name:/I reviewed this statement/}).check();
  await page.getByRole("button",{name:"Review operation",exact:true}).click();
  await expect(page.getByRole("region",{name:"Review settlement operation"})).toBeVisible();
  const result=page.waitForResponse(r=>r.request().method()==="POST"&&r.url().includes("/admin/gospaza/")&&r.status()===200);
  await page.getByRole("button",{name:"Confirm "+label,exact:true}).click();await result;
}
async function transferFields(page:Page,failed=false) {
  if(!failed) await page.getByLabel("Observed amount in ZAR cents",{exact:true}).fill("9000");
  await page.getByLabel("Verified beneficiary reference",{exact:true}).fill("browser_verified_beneficiary");
  await page.getByLabel("Originating channel/account reference",{exact:true}).fill("browser_private_origin");
  await page.getByLabel(/^External transfer ID/).fill("browser_bank_"+randomUUID());
  const local=await page.evaluate(()=>{const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,23);});
  await page.getByLabel("Actual transfer local date and time",{exact:true}).fill(local);
  if(failed) {await page.getByLabel("Evidence reference",{exact:true}).fill("browser_nonreceipt_evidence");
    await page.getByRole("checkbox",{name:/An external transfer was attempted/}).check();}
}
test("platform reviews, records an external payout and separately reconciles it",async({page})=>{
  await login(page,admin,f.actors.operator.email);await openPlatform(page,f.statements.lifecycle.id,"READY_FOR_APPROVAL");
  await expect(page.getByRole("heading",{name:"Ready for approval",exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Period statement"})).toContainText("Tax held");
  await page.getByRole("button",{name:"Approve settlement",exact:true}).click();await review(page,"approve settlement");
  await expect(page.getByRole("heading",{name:"Approved",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Record external transfer",exact:true}).click();
  await expect(page.getByText(/GoSpaza does not send money/)).toBeVisible();await transferFields(page);await review(page,"record external transfer");
  await expect(page.getByRole("heading",{name:"External payout recorded",exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Recorded external payout"})).toContainText("Reconciliation pending");
  await page.reload();await expect(page.getByRole("heading",{name:"External payout recorded",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Reconcile recorded payout",exact:true}).click();
  await expect(page.getByRole("region",{name:"Payout evidence"})).toContainText("browser_verified_beneficiary");
  await page.getByLabel("Review reference",{exact:true}).fill("browser_reconciliation_review");await review(page,"reconcile recorded payout");
  await expect(page.getByRole("heading",{name:"Reconciled",exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole("heading",{name:"Reconciled",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Record external transfer",exact:true})).toHaveCount(0);
});
test("failed external attempt remains visible after an explicitly authorized retry",async({page})=>{
  await login(page,admin,f.actors.operator.email);await openPlatform(page,f.statements.failure.id,"APPROVED");
  await page.getByRole("button",{name:"Record failed transfer attempt",exact:true}).click();await transferFields(page,true);await review(page,"record failed transfer attempt");
  await expect(page.getByRole("heading",{name:"Failed transfer attempt",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Authorize payout retry",exact:true}).click();await expect(page.getByRole("heading",{name:"Prior failed attempt",exact:true})).toBeVisible();
  await page.getByLabel("Review reference",{exact:true}).fill("browser_failure_review");await review(page,"authorize payout retry");
  await expect(page.getByRole("heading",{name:"Approved",exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Failed payout attempts",exact:true})).toBeVisible();
  const data=await (await page.request.get(api+"/admin/gospaza/merchant-settlements/"+f.statements.failure.id)).json() as PlatformSettlementDetail;
  expect(data.failures).toHaveLength(1);expect(data.payment).toBeNull();
});
test("merchant owner and manager read only their own statement; picker and foreign tenant are denied",async({page,browser})=>{
  await login(page,merchant,f.actors.owner.email);await page.goto(merchant+"/merchant/settlements/"+f.statements.merchant.id);
  await expect(page.getByRole("heading",{name:"Reconciled",exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Period statement"})).toContainText("Tax held");
  await expect(page.getByRole("button",{name:/Approve settlement|Record external transfer|Authorize payout retry|Reconcile recorded payout/})).toHaveCount(0);
  for(const hidden of ["merchant_fixture_private_beneficiary","merchant_fixture_private_origin","merchant_fixture_private_proof","merchant_fixture_private_review"])
    await expect(page.locator("body")).not.toContainText(hidden);
  const response=await page.request.get(api+"/merchant/settlements/"+f.statements.merchant.id);expect(response.status()).toBe(200);
  const data=await response.json() as MerchantSettlementDetail;expect(data.statement.payment_status).toBe("RECONCILED");
  const foreign=await page.request.get(api+"/merchant/settlements/"+f.statements.foreign.id);expect(foreign.status()).toBe(404);
  const unknown=await page.request.get(api+"/merchant/settlements/unknown_statement");expect(await foreign.json()).toEqual(await unknown.json());
  for(const role of ["manager","picker","foreign"] as const) {
    const context=await browser.newContext();try {
      const other=await context.newPage();await login(other,merchant,f.actors[role].email);
      const check=await context.request.get(api+"/merchant/settlements/"+f.statements.merchant.id);
      expect(check.status()).toBe(role==="manager"?200:role==="picker"?403:404);
      await other.goto(merchant+"/merchant/settlements/"+f.statements.merchant.id);
      if(role==="manager") await expect(other.getByRole("heading",{name:"Reconciled",exact:true})).toBeVisible();
      else {await expect(other.getByRole("alert")).toBeVisible();await expect(other.getByRole("region",{name:"Period statement"})).toHaveCount(0);}
    } finally {await context.close();}
  }
});
