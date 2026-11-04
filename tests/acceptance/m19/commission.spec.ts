import { expect,test,type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import type { AdminOrderEconomics } from "@gospaza/contracts";
const f=JSON.parse(readFileSync(process.env.M19_BROWSER_MANIFEST!,"utf8"));
if(f.version!==1) throw new Error("Unsupported M19 fixture manifest.");
const admin="http://localhost:3003",merchant="http://localhost:3001",api="http://localhost:9000";
async function login(page:Page,app:string,email:string) {
  await page.goto(app+"/login");await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password",{exact:true}).fill(createHmac("sha256",process.env.M19_VERIFY_SECRET!).update(email).digest("hex"));
  await Promise.all([page.waitForURL(url=>url.origin===app && url.pathname!=="/login"),page.getByRole("button",{name:"Sign in",exact:true}).click()]);
}
test("commission administrator publishes a future zero-rate merchant override",async({page})=>{
  await login(page,admin,f.writer);await page.goto(admin+"/admin/commissions");
  await page.getByLabel(/Merchant reference/).fill(f.writeMerchant);await page.getByRole("button",{name:"View rules"}).click();
  await expect(page.getByRole("heading",{name:"Merchant "+f.writeMerchant,exact:true})).toBeVisible();
  await expect(page.getByText("No published decisions on this page.")).toBeVisible();
  await page.getByLabel(/Rate in basis points/).fill("0");
  await page.getByRole("combobox",{name:"Effective time",exact:true}).selectOption("future");
  await page.getByLabel("Effective local date and time").fill(new Date(Date.now()+7*86400000).toISOString().slice(0,16));
  await page.getByLabel("Reason",{exact:true}).fill("Dedicated browser commission decision");
  await page.getByRole("button",{name:"Review decision",exact:true}).click();
  await expect(page.getByText(/Set rate 0\.00%/)).toBeVisible();
  const [post]=await Promise.all([page.waitForResponse(r=>r.url()===api+"/admin/gospaza/commission-rules" && r.request().method()==="POST"),
    page.getByRole("button",{name:"Confirm publication"}).click()]);
  expect(post.status()).toBe(200);
  const row=page.getByRole("row").filter({hasText:"Dedicated browser commission decision"});
  await expect(row).toContainText("Future");await expect(row).toContainText("0.00%");
});
test("finance viewer inspects an earned order and a known-zero return",async({page})=>{
  await login(page,admin,f.viewer);await page.goto(admin+"/admin/financial-adjustments");
  for(const id of [f.order,f.zero]) {
    await page.getByLabel("Order reference",{exact:true}).fill(id);
    const [res]=await Promise.all([page.waitForResponse(r=>r.url()===api+"/admin/gospaza/orders/"+id+"/finance-snapshot"),
      page.getByRole("button",{name:"Inspect order economics"}).click()]);
    expect(res.status()).toBe(200);
    const dto:AdminOrderEconomics=await res.json(),panel=page.getByRole("region",{name:"Marketplace economics"});
    if(id===f.zero) {
      expect(dto.state).toBe("KNOWN_ZERO");await expect(panel).toContainText("No merchandise earnings");
      await expect(panel.getByText("Merchant merchandise entitlement")).toHaveCount(0);
    } else {
      expect(dto.state).toBe("EARNED");expect(dto.basis_points).toBe(800);await expect(panel).toContainText("8.00%");
      expect(dto.earned).toBeTruthy();
      for(const [label,value] of [["Commission basis",dto.earned!.basis_minor],["Platform commission",dto.earned!.commission_minor],
        ["Merchant merchandise entitlement",dto.earned!.entitlement_minor]] as const)
        await expect(panel.getByText(label,{exact:true}).locator("xpath=following-sibling::dd[1]")).toContainText(
          new Intl.NumberFormat("en-ZA",{style:"currency",currency:"ZAR"}).format(value/100));
    }
  }
  await page.goto(admin+"/admin/commissions");await expect(page.getByText(/Current effective rate/)).toBeVisible();
  await expect(page.getByRole("button",{name:"Review decision"})).toHaveCount(0);
});
test("merchant order economics are visible only within the entitled tenant",async({browser})=>{
  for(const [email,status] of [[f.owner,200],[f.picker,403],[f.foreign,404]] as const) {
    const context=await browser.newContext();
    try {
      const page=await context.newPage();await login(page,merchant,email);
      const url=merchant+"/merchant/orders/"+f.order,path=api+"/merchant/orders/"+f.order+"/economics";
      if(status===200) {
        const [response]=await Promise.all([page.waitForResponse(r=>r.url()===path),page.goto(url)]);
        expect(response.status()).toBe(200);
        const panel=page.getByRole("region",{name:"Marketplace economics"});await expect(panel).toContainText("Merchant merchandise entitlement");
        await expect(panel).toContainText("8.00%");
      } else {
        await page.goto(url);
        expect((await page.request.get(path)).status()).toBe(status);
        if(status===403) await expect(page.getByRole("heading",{name:"Order access unavailable"})).toBeVisible();
        else await expect(page.getByRole("alert").first()).toBeVisible();
        await expect(page.getByText("Merchant merchandise entitlement")).toHaveCount(0);
      }
    } finally {await context.close();}
  }
});
