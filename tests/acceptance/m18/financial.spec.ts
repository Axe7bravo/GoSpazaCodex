import { expect,test,type Page,type Browser,type Request } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { holdFinancialFixtureStock } from "../../../apps/backend/src/scripts/fixtures/financial-stock-gate";
import type { CustomerFinancialResolution, AdminFinancialOrder, FinancialAdjustmentView, DispositionLine } from "@gospaza/contracts";

interface Manifest {
  key:string; mixed:{email:string;sourceOrder:string;mixedOrder:string;variantId:string;cartId:string;addressId:string};
  owner:string;manager:string;managerId:string;picker:string;foreignMerchant:string;
  viewer:{email:string};inventoryViewer:{email:string};deniedAdmin:{email:string};
  delivery:string;returnedOrder:string;stockGateId:string;returnEmail:string;restock:{deliveryId:string;orderId:string};nonSellable:{deliveryId:string;orderId:string};attention:{deliveryId:string;orderId:string};
  refunds:Record<"UNKNOWN"|"FAILED"|"SETTLED",{order:string;email:string}>;queueOrder:string;queueEmail:string;location:object;
}
const fixture:Manifest=JSON.parse(readFileSync(process.env.M18_BROWSER_MANIFEST!,"utf8"));
const api="http://localhost:9000",customer="http://localhost:3000",merchant="http://localhost:3001",admin="http://localhost:3003";
const amount=(minor:number)=>new Intl.NumberFormat("en-ZA",{currency:"ZAR",style:"currency"}).format(minor/100);
const customerPath=(order:string)=>"/store/gospaza/orders/"+order+"/financial-resolution";
const merchantPath=(order:string)=>"/merchant/orders/"+order+"/financial-resolution";
const stockPath=(delivery:string)=>"/merchant/deliveries/"+delivery+"/dispositions";
async function login(page:Page,app:string,email:string) {
  await page.goto(app+"/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password",{exact:true}).fill(createHmac("sha256",process.env.M18_BROWSER_SECRET!).update(email).digest("hex"));
  await Promise.all([page.waitForURL(url=>url.origin===app && url.pathname!=="/login"),page.getByRole("button",{name:"Sign in",exact:true}).click()]);
}
async function request(page:Page,path:string,status:number,method="GET",data?:object) {
  const response=await page.request.fetch(api+path,{method,data,headers:path.startsWith("/store/")?{"x-publishable-api-key":fixture.key}:{}});
  expect(response.status(),method+" "+path).toBe(status);
  if(status===204) return null;
  return response.json();
}
async function account(browser:Browser,app:string,email:string) {
  const context=await browser.newContext();
  const page=await context.newPage();
  await login(page,app,email);
  return {context,page};
}
async function signOutOpenPage(page:Page,path:string) {
  await request(page,"/auth/session",200,"DELETE");
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL(/\/login$/);
  await request(page,path,401);
}
const publicFields=["reason","amount_minor","currency","status","default_method","settled_minor","refund_status","credit_status"];
function publicRows(rows:CustomerFinancialResolution["adjustments"],merchantView=false) {
  for(const row of rows) expect(Object.keys(row).filter(k=>!publicFields.includes(k) && !(merchantView && k==="financial_cause"))).toEqual([]);
}

test("customer balance and completed mixed funding survive refresh; a known foreign order discloses nothing",async({page})=>{
  const m=fixture.mixed;
  await login(page,customer,m.email);
  await page.goto(customer+"/account");
  const balance=await request(page,"/store/gospaza/balance",200);
  expect(balance).toEqual({currency:"zar",balance_minor:6342});
  await expect(page.getByRole("region",{name:"GoSpaza balance"})).toContainText(amount(balance.balance_minor));
  await page.goto(customer+"/orders/"+m.sourceOrder);
  await expect(page.getByText(/Credit added to GoSpaza balance/)).toBeVisible();
  const source=await request(page,customerPath(m.sourceOrder),200);
  publicRows(source.adjustments);
  expect(source.adjustments).toContainEqual(expect.objectContaining({settled_minor:6342,credit_status:"CREDIT_ADDED"}));
  await page.goto(customer+"/orders/"+m.mixedOrder);
  await page.reload();
  const order:CustomerFinancialResolution=await request(page,customerPath(m.mixedOrder),200);
  expect(order.funding).toEqual({gross_minor:10000,store_credit_minor:6342,original_payment_minor:3658});
  const panel=page.getByRole("region",{name:"Payment and adjustments"});
  for(const minor of Object.values(order.funding)) await expect(panel).toContainText(amount(minor));
  const foreign=fixture.refunds.SETTLED.order;
  const denied=await request(page,customerPath(foreign),404);
  expect(denied).toEqual(await request(page,customerPath("order_missing"),404));
  await page.goto(customer+"/orders/"+foreign);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(panel).toHaveCount(0);
  await page.goto(customer+"/orders/"+m.sourceOrder);
  await expect(page.getByText(/Credit added to GoSpaza balance/)).toBeVisible();
  await signOutOpenPage(page,customerPath(m.sourceOrder));
  await expect(page.getByText(/Credit added to GoSpaza balance/)).toHaveCount(0);
});

test("customer applies and removes balance, then reloads the server-confirmed quote",async({page})=>{
  const m=fixture.mixed;
  await login(page,customer,m.email);
  // The verified C2B fixture leaves a small cart for its full-credit rejection check.
  // Replace that item on the same owned cart using normal customer commands.
  const cart=(await request(page,"/store/gospaza/cart",200)).cart;
  expect(cart.id).toBe(m.cartId);
  const existing=cart.items.find((line:{variant_id:string})=>line.variant_id===m.variantId);
  if(existing) expect(existing.quantity).toBe(1);
  else await request(page,"/store/gospaza/cart/items",200,"POST",{cart_id:cart.id,variant_id:m.variantId,quantity:1,location:fixture.location});
  for(const line of cart.items) if(line.variant_id!==m.variantId)
    await request(page,"/store/gospaza/cart/items/"+line.id,200,"DELETE",{cart_id:cart.id});
  const options=await request(page,"/store/gospaza/cart/delivery-options",200,"POST",{cart_id:cart.id,location:{address_id:m.addressId}});
  const option=options.options.find((o:{mode:string})=>o.mode==="SCHEDULED");
  expect(option).toBeTruthy();expect(options.slots.length).toBeGreaterThan(0);
  await request(page,"/store/gospaza/cart/delivery-selection",200,"PUT",{cart_id:cart.id,option_id:option.id,
    expected_option_revision:option.revision,expected_revision:options.revision,slot_id:options.slots[0].id,location:{address_id:m.addressId}});
  await page.goto(customer+"/checkout");
  await page.getByRole("button",{name:"Review current cart"}).click();
  for(const use of [true,false,true]) {
    const [response]=await Promise.all([page.waitForResponse(r=>r.url()===api+"/store/gospaza/balance" && r.request().method()==="POST"),
      page.getByRole("button",{name:use?"Use available balance":"Remove balance from checkout"}).click()]);
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({currency:"zar",gross_minor:10000,applied_minor:use?6342:0,external_payable_minor:use?3658:10000});
    await expect(page.getByRole("status").filter({hasText:"Remaining to pay"})).toContainText(amount(use?3658:10000));
  }
  await page.getByLabel("Delivery address").selectOption(m.addressId);
  const [prepare]=await Promise.all([page.waitForRequest(r=>r.url()===api+"/store/gospaza/checkout/prepare" && r.method()==="POST"),
    page.getByRole("button",{name:"Review checkout",exact:true}).click()]);
  const response=await prepare.response();
  if(!response) throw new Error("Checkout prepare failed before headers: "+(prepare.failure()?.errorText ?? "unknown transport error"));
  const result=await response.json();
  expect(response.status(),"Checkout prepare returned "+response.status()+" ("+(result.code ?? "no code")+")").toBe(200);
  expect(result.quote).toMatchObject({cart_id:m.cartId,store_credit_minor:6342,totals:{total_minor:3658}});
  await expect(page.getByRole("heading",{name:"Confirm checkout",exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Order total"})).toContainText(amount(3658),{timeout:45000});
  await page.getByRole("button",{name:"Confirm checkout",exact:true}).click();
  await expect(page.getByRole("button",{name:"Pay securely with Yoco"})).toBeVisible({timeout:45000});
  await page.reload();
  const restored=await request(page,"/store/gospaza/checkout/status",200);
  expect(restored.state).toBe("ready_to_pay");
  expect(restored.attempt.quote.cart_id).toBe(m.cartId);
  expect(restored.attempt.quote.store_credit_minor).toBe(6342);
  expect(restored.attempt.quote.totals.total_minor).toBe(3658);
  await expect(page.getByRole("region",{name:"Order total"})).toContainText(amount(6342));
  expect((await request(page,"/store/gospaza/balance",200)).balance_minor).toBe(6342);
});

for(const [state,text] of [["UNKNOWN","Refund processing"],["FAILED","Refund failed"],["SETTLED","Refunded to original payment method"]] as const) {
  test("customer rejected Order displays persisted "+state+" refund separately from fulfillment",async({page})=>{
    const f=fixture.refunds[state];
    await login(page,customer,f.email);
    await page.goto(customer+"/orders/"+f.order);
    const data:CustomerFinancialResolution=await request(page,customerPath(f.order),200);
    publicRows(data.adjustments);
    const row=data.adjustments.find(r=>r.reason==="MERCHANT_REJECTED");
    expect(row?.default_method).toBe("ORIGINAL_PAYMENT");
    expect(row?.refund_status).toBe(({UNKNOWN:"PENDING",FAILED:"FAILED",SETTLED:"SUCCEEDED"} as const)[state]);
    const panel=page.getByRole("region",{name:"Payment and adjustments"});
    await expect(panel).toContainText(text);
    await expect(panel).toContainText(amount(row!.amount_minor));
    await expect(page.getByText(/This order will not be fulfilled/)).toBeVisible();
    await expect(panel).not.toContainText("Credit added");
  });
}

test("customer sees review-only goodwill separately from an approved or paid adjustment",async({page})=>{
  await login(page,customer,fixture.queueEmail);
  const [response]=await Promise.all([page.waitForResponse(r=>r.url()===api+customerPath(fixture.queueOrder) && r.request().method()==="GET"),
    page.goto(customer+"/orders/"+fixture.queueOrder)]);
  expect(response.status()).toBe(200);
  const data:CustomerFinancialResolution=await response.json();
  publicRows(data.adjustments);
  expect(data.adjustments).toContainEqual(expect.objectContaining({reason:"GOODWILL",status:"REVIEW_REQUIRED",amount_minor:1,settled_minor:0}));
  const panel=page.getByRole("region",{name:"Payment and adjustments"});
  await expect(panel).toContainText("Awaiting approval");
  await expect(panel).toContainText("Amount under review");
  await expect(panel).not.toContainText("Credit added to GoSpaza balance");
});

test("customer return custody does not disclose platform evidence or claim settlement",async({page})=>{
  await login(page,customer,fixture.returnEmail);
  const financialPath=customerPath(fixture.returnedOrder);
  const trackingPath="/store/gospaza/orders/"+fixture.returnedOrder+"/tracking";
  const started=Date.now();
  const ids=new Map<Request,number>();
  const safeURL=(url:string)=>url.split(/[?#]/)[0];
  const record=(event:string,req?:Request,detail?:string|number)=>{
    console.log("M18 custody "+JSON.stringify({ms:Date.now()-started,event,page:safeURL(page.url()),
      index:req && ids.get(req),url:req && safeURL(req.url()),detail}));
  };
  page.on("request",req=>{
    if(req.isNavigationRequest() && req.frame()===page.mainFrame()) record("navigation-start",undefined,safeURL(req.url()));
    if(req.method()==="GET" && req.url()===api+financialPath) {
      ids.set(req,ids.size+1);
      record("request-start",req);
    }
  });
  page.on("framenavigated",frame=>{if(frame===page.mainFrame()) record("navigation-commit");});
  page.on("response",res=>{if(ids.has(res.request())) record("headers",res.request(),res.status());});
  page.on("requestfinished",req=>{if(ids.has(req)) record("finished",req);});
  page.on("requestfailed",req=>{if(ids.has(req)) record("failed",req,req.failure()?.errorText);});
  async function completedRead(path:string) {
    const req=await page.waitForEvent("requestfinished",{predicate:async req=>
      req.method()==="GET" && req.url()===api+path && (await req.response())?.status()===200});
    const response=await req.response();
    if(!response) throw new Error("Missing completed customer response for "+path);
    return response.json();
  }
  const [data,tracking]=await Promise.all([completedRead(financialPath),completedRead(trackingPath),page.goto(customer+"/orders/"+fixture.returnedOrder)]);
  expect(tracking.state).toBe("RETURNED_TO_STORE");
  publicRows(data.adjustments);
  expect(data.adjustments.some(row=>row.reason==="RESTRICTED_HANDOFF_FAILED")).toBe(true);
  await expect(page.getByText(/A physical return does not confirm a refund or credit/)).toBeVisible();
  await expect(page.getByRole("region",{name:"Payment and adjustments"})).toContainText("Restricted delivery could not be completed");
  await expect(page.locator("body")).not.toContainText("school_uniform");
});

test("merchant own order, foreign order and return enforce distinct role boundaries",async({page})=>{
  await login(page,merchant,fixture.owner);
  await page.goto(merchant+"/merchant/orders/"+fixture.returnedOrder);
  const data=await request(page,merchantPath(fixture.returnedOrder),200);
  publicRows(data.adjustments,true);
  expect(data.adjustments.length).toBeGreaterThan(0);
  await expect(page.getByText(/Attribution:/).first()).toBeVisible();
  await expect(page.getByText(amount(data.adjustments[0].amount_minor),{exact:false}).first()).toBeVisible();
  await expect(page.getByRole("button",{name:/issue credit|execute refund/i})).toHaveCount(0);
  const foreign=fixture.mixed.sourceOrder;
  expect(await request(page,merchantPath(foreign),404)).toEqual(await request(page,merchantPath("order_missing"),404));
  await page.goto(merchant+"/merchant/orders/"+foreign);
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByRole("heading",{name:"Order adjustments"})).toHaveCount(0);
  await signOutOpenPage(page,merchantPath(fixture.returnedOrder));
  await login(page,merchant,fixture.foreignMerchant);
  await page.goto(merchant+"/merchant/returns");
  const queue=await request(page,"/merchant/deliveries/returns?offset=0",200);
  expect(queue.items.some((x:{delivery_id:string})=>x.delivery_id===fixture.delivery)).toBe(false);
  expect(await request(page,stockPath(fixture.delivery),404)).toEqual(await request(page,stockPath("delivery_missing"),404));
  await request(page,stockPath(fixture.delivery),404,"POST",{line_id:"line_known",decision:"RESTOCK",confirmed:true});
  await expect(page.getByRole("button",{name:"Confirm stock decision"})).toHaveCount(0);
});

async function openReturn(page:Page,deliveryId:string) {
  await page.goto(merchant+"/merchant/returns");
  const queue=await request(page,"/merchant/deliveries/returns?offset=0",200);
  const item=queue.items.find((x:{delivery_id:string})=>x.delivery_id===deliveryId);
  expect(item?.state).toBe("RETURNED_TO_STORE");
  await page.getByRole("button",{name:"Open return for order "+item.order_reference,exact:true}).click();
}
test("PICKER can view physical receipt but cannot inspect or decide stock",async({page})=>{
  await login(page,merchant,fixture.picker);
  await openReturn(page,fixture.delivery);
  await expect(page.getByText(/Physical custody acknowledged/)).toBeVisible();
  await expect(page.getByRole("heading",{name:"Returned stock"})).toHaveCount(0);
  await request(page,stockPath(fixture.delivery),403);
  await request(page,stockPath(fixture.delivery),403,"POST",{line_id:"line_known",decision:"RESTOCK",confirmed:true});
});
for(const [decision,label,done] of [["RESTOCK","Restock","Restock completed."],["NON_SELLABLE","Mark non-sellable","Recorded as non-sellable."]] as const) {
  test("merchant "+decision+" shows only the refetched stock decision",async({page})=>{
    const deliveryId=decision==="RESTOCK"?fixture.restock.deliveryId:fixture.nonSellable.deliveryId;
    await login(page,merchant,decision==="RESTOCK"?fixture.owner:fixture.manager);
    await openReturn(page,deliveryId);
    const path=stockPath(deliveryId);
    const before=await request(page,path,200);
    expect(before.items).toHaveLength(1);expect(before.items[0].status).toBe("UNDECIDED");
    await request(page,path,400,"POST",{confirmed:true,line_id:before.items[0].line_id,decision,quantity:9999});
    await page.getByRole("button",{name:label,exact:true}).click();
    const observer=decision==="RESTOCK" ? await page.context().newPage():undefined;
    if(observer) {
      await openReturn(observer,deliveryId);
      await expect(observer.getByRole("button",{name:"Restock",exact:true}).first()).toBeVisible();
    }
    const release=observer ? await holdFinancialFixtureStock(fixture.stockGateId):undefined;
    const committed=Promise.all([page.waitForResponse(r=>r.url()===api+path && r.request().method()==="POST"),
      page.waitForResponse(r=>r.url()===api+path && r.request().method()==="GET")]);
    // Subscribe before the single write. A second page sees only the server state.
    void committed.catch(()=>{});
    try {
      await page.getByRole("button",{name:"Confirm stock decision"}).click();
      if(observer) {
        await expect.poll(async()=>(await request(page,path,200)).items[0].status).toBe("DISPATCHED");
        await observer.getByRole("button",{name:"Refresh stock decisions"}).click();
        await expect(observer.getByText("Stock update in progress.")).toBeVisible();
      }
    } finally {await release?.();await observer?.close();}
    const [write,read]=await committed;
    expect(write.status()).toBe(200);expect(read.status()).toBe(200);
    const body:{items:DispositionLine[]}=await read.json();
    expect(body.items[0]).toEqual({...before.items[0],status:"COMPLETED",decision});
    await expect(page.getByText(done,{exact:true})).toBeVisible();
    await openReturn(page,deliveryId);
    await expect(page.getByText(done,{exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Confirm stock decision"})).toHaveCount(0);
  });
}
test("merchant sees durable inventory attention without an automatic retry",async({page})=>{
  await login(page,merchant,fixture.owner);
  await openReturn(page,fixture.attention.deliveryId);
  const lines=await request(page,stockPath(fixture.attention.deliveryId),200);
  expect(lines.items[0].status).toBe("ATTENTION_REQUIRED");
  await expect(page.getByText("Stock update needs review. Do not submit it again.")).toBeVisible();
  await expect(page.getByRole("button",{name:"Confirm stock decision"})).toHaveCount(0);
});

test("removing active manager membership clears an open financial order and denies direct read",async({browser})=>{
  const manager=await account(browser,merchant,fixture.manager),owner=await account(browser,merchant,fixture.owner);
  try {
    await manager.page.goto(merchant+"/merchant/orders/"+fixture.returnedOrder);
    await expect(manager.page.getByText(/Attribution:/).first()).toBeVisible();
    const path="/merchant/team/members/"+fixture.managerId;
    await request(owner.page,path,200,"PATCH",{status:"INACTIVE"});
    try {
      await manager.page.evaluate(()=>window.dispatchEvent(new Event("focus")));
      await expect(manager.page).toHaveURL(/\/(application|login)$/);
      await request(manager.page,merchantPath(fixture.returnedOrder),401);
      await expect(manager.page.getByText(/Attribution:/)).toHaveCount(0);
    } finally { await request(owner.page,path,200,"PATCH",{status:"ACTIVE"}); }
  } finally {await manager.context.close();await owner.context.close();}
});

const queuePath="/admin/gospaza/financial-adjustments?limit=20&offset=";
async function selectOrder(page:Page,order:string,expected:string) {
  await page.goto(admin+"/admin/financial-adjustments");
  let offset=0;
  while(true) {
    const data=await request(page,queuePath+offset,200);
    expect(data.adjustments.length).toBeLessThanOrEqual(20);
    if(data.adjustments.some((r:FinancialAdjustmentView)=>r.order_id===order)) break;
    expect(data.adjustments.length,"fixture must be present in the real queue").toBe(20);
    offset+=20;
    expect(offset).toBeLessThanOrEqual(10000);
    await Promise.all([page.waitForResponse(r=>r.url()===api+queuePath+offset),page.getByRole("button",{name:"Next page"}).click()]);
  }
  const button=page.getByRole("button",{name:new RegExp("^"+order+" ·")}).first();
  await expect(button.locator("xpath=ancestor::tr")).toContainText(expected);
  await button.click();
  await expect(page.getByRole("heading",{name:"Adjustment detail"})).toBeVisible();
  const detailPath="/admin/gospaza/orders/"+order+"/financial-resolution";
  const detail:AdminFinancialOrder=await request(page,detailPath,200);
  const row=detail.adjustments.find(r=>r.order_id===order && r.reason==="MERCHANT_REJECTED") ?? detail.adjustments[0];
  expect(row).toBeDefined();
  const section=page.getByRole("heading",{name:"Adjustment detail"}).locator("..");
  await expect(section).toContainText(expected);
  for(const [field,minor] of [["Reserved",row!.reserved_minor],["Settled",row!.settled_minor],["Unsettled",row!.unsettled_minor]] as const)
    await expect(section.getByText(field,{exact:true}).locator("xpath=following-sibling::dd[1]")).toContainText(amount(minor));
  for(const component of row!.components) await expect(section).toContainText(amount(component.amount_minor));
  expect(detail.history.some(e=>e.adjustment_id===row!.id)).toBe(true);
  await expect(section.getByRole("list").first().getByRole("listitem").first()).toBeVisible();
  return detail;
}
test("admin queue paginates and distinguishes ambiguous refund from settled refund",async({page})=>{
  await login(page,admin,fixture.viewer.email);
  await page.goto(admin+"/admin/financial-adjustments");
  const first=await request(page,queuePath+0,200);expect(first.adjustments).toHaveLength(20);
  const [response]=await Promise.all([page.waitForResponse(r=>r.url()===api+queuePath+20),page.getByRole("button",{name:"Next page"}).click()]);
  const second=await response.json();
  expect(second.offset).toBe(20);expect(second.adjustments.length).toBeGreaterThan(0);
  expect(second.adjustments.some((r:FinancialAdjustmentView)=>first.adjustments.some((a:FinancialAdjustmentView)=>a.id===r.id))).toBe(false);
  await expect(page.getByRole("button",{name:new RegExp("^"+second.adjustments[0].order_id)}).first()).toBeVisible();
  const unknown=await selectOrder(page,fixture.refunds.UNKNOWN.order,"Refund outcome unknown");
  expect(unknown.adjustments[0]?.refund_operation_state).toBe("UNKNOWN");
  const settled=await selectOrder(page,fixture.refunds.SETTLED.order,"Refunded to original payment method");
  expect(settled.adjustments[0]?.refund_operation_state).toBe("SETTLED");
  await expect(page.getByRole("button",{name:/issue credit|execute refund|approve adjustment/i})).toHaveCount(0);
  await signOutOpenPage(page,queuePath+0);
  await expect(page.getByRole("table")).toHaveCount(0);
});

for(const entitled of [false,true]) test("admin disposition grant "+entitled+" controls response and page",async({page})=>{
  await login(page,admin,(entitled?fixture.inventoryViewer:fixture.viewer).email);
  // The attention fixture has a recorded stock decision before any browser write.
  const order=fixture.attention.orderId;
  const path="/admin/gospaza/orders/"+order+"/financial-resolution";
  const data:AdminFinancialOrder=await request(page,path,200);
  expect(data.adjustments.length).toBeGreaterThan(0);
  const detail=await selectOrder(page,order,"awaiting settlement");
  const heading=page.getByRole("heading",{name:"Recorded stock decisions for this order"});
  if(entitled) {
    expect(detail.dispositions?.some(d=>d.status==="ATTENTION_REQUIRED")).toBe(true);
    await expect(heading).toBeVisible();
    await expect(heading.locator("..")).toContainText("attention required");
  } else {
    expect(Object.hasOwn(detail,"dispositions")).toBe(false);
    await expect(heading).toHaveCount(0);
  }
});
test("platform session alone cannot enumerate financial data or execute financial commands",async({page})=>{
  await login(page,admin,fixture.deniedAdmin.email);
  await page.goto(admin+"/admin/financial-adjustments");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await request(page,queuePath+0,403);
  await request(page,"/admin/gospaza/orders/"+fixture.returnedOrder+"/financial-resolution",403);
  await request(page,"/admin/gospaza/financial-adjustments/fadj_known/store-credit",403,"POST",{confirmed:true});
});

const postRemovalOnly=process.env.M18_VERIFY_ALREADY_REVOKED==="true";
test((postRemovalOnly?"already-revoked viewer retains ordinary financial detail":"live grant revocation removes stock evidence from an open admin detail")+" @revoke",async({page})=>{
  test.setTimeout(300000);
  await login(page,admin,fixture.inventoryViewer.email);
  const order=fixture.attention.orderId,path="/admin/gospaza/orders/"+order+"/financial-resolution";
  const detail=await selectOrder(page,order,"awaiting settlement");
  const heading=page.getByRole("heading",{name:"Recorded stock decisions for this order"});
  if(postRemovalOnly) {
    expect(Object.hasOwn(detail,"dispositions")).toBe(false);
    await expect(heading).toHaveCount(0);
  } else {
  expect(detail.dispositions?.length).toBeGreaterThan(0);
  await expect(heading).toBeVisible();
  console.log("M18 REVOCATION READY: restart the test backend without the disposition grant, keeping both VIEW grants.");
  await expect.poll(async()=>{
    const response=await page.request.get(api+path,{failOnStatusCode:false}).catch(()=>null);
    if(response?.status()!==200) return false;
    return !Object.hasOwn(await response.json(),"dispositions");
  },{timeout:240000}).toBe(true);
  }
  const [response]=await Promise.all([page.waitForResponse(r=>r.url()===api+path && r.request().method()==="GET"),
    page.evaluate(()=>window.dispatchEvent(new Event("focus")))]);
  expect(response.status(),"Financial detail GET "+response.url()+" from "+page.url()).toBe(200);
  const body:AdminFinancialOrder=await response.json();
  console.log("M18 revoked detail", {page:page.url(),url:response.url(),status:response.status(),
    adjustments:Array.isArray(body.adjustments),history:Array.isArray(body.history),dispositions:Object.hasOwn(body,"dispositions")});
  expect(Object.hasOwn(body,"dispositions")).toBe(false);
  const adjustment=body.adjustments.find(row=>row.order_id===order && row.id===detail.adjustments[0]?.id);
  expect(adjustment).toBeDefined();
  expect(body.history.some(event=>event.adjustment_id===adjustment?.id)).toBe(true);
  await expect(heading).toHaveCount(0);
  await expect(page).toHaveURL(admin+"/admin/financial-adjustments");
  const section=page.getByRole("heading",{name:"Adjustment detail"}).locator("..");
  await expect(section).toContainText(order);
  await expect(section.getByRole("heading",{name:"Recent adjustment activity"})).toBeVisible();
  await expect(section.getByRole("listitem").first()).toBeVisible();
  await expect(heading).toHaveCount(0);
});
