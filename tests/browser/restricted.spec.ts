import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fixture, offer } from "./fixtures/delivery";
import type { RecipientObservation, PhysicalReturnState } from "@gospaza/contracts";

async function compliance(page:Page, role="OWNER") {
  const base=await fixture(page);base.commitment={...offer(),status:"ASSIGNED"};base.availability.effective="BUSY";
  // Restricted handoff/return fixtures already have an assigned delivery.
  // The customer mounts tracking from this separate authoritative dispatch read.
  base.delivery={status:"ASSIGNED"};
  const state={phase:"ARRIVED",compliance:"REQUIRED",returnState:null as PhysicalReturnState|null,arrived:false,revision:4,
    outcome:"SATISFIED",lost:false,denied:false,registration:"PENDING_REVIEW",reviewCurrent:true,purchaser:"UNAVAILABLE",
    writes:[] as {path:string;body:Record<string,unknown>}[],reads:[] as string[],gate:undefined as Promise<void>|undefined};
  const premises={address_line_1:"1 Store Street",address_line_2:"",city:"Bloemfontein",province:"FS",postal_code:"9301",country_code:"za"};
  const submission={registration_number:"REG-FIXTURE",category:"GROCER_WINE",issuing_authority:"Fixture authority",valid_from:null,valid_until:null,evidence_ids:["evidence_fixture"]};
  const recipient=()=>({delivery_id:"delivery_fixture",revision:state.revision,compliance:state.compliance,return_state:state.returnState,
    awaiting_store_receipt:state.arrived&&state.returnState!=="RETURNED_TO_STORE",financial_review_required:!!state.returnState,origin_store:{name:"Fixture Shop",address:premises}});
  const registration=()=>({registration:{id:"registration_fixture",status:state.registration,revision:state.revision,submission,pending_submission:null,submitted_at:"2026-10-27T08:00:00Z",reviewed_at:null},
    evidence:[{id:"evidence_fixture",display_name:"Licence.pdf",mime_type:"application/pdf",size_bytes:100}],premises,review_note:"Review the store registration conditions."});
  await page.route("http://localhost:9000/**",async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname,method=req.method();
    const handled=path==="/merchant/me"||path==="/merchant/products/product_fixture"||path.startsWith("/store/gospaza/checkout")||path.startsWith("/store/gospaza/cart")||path==="/store/gospaza/addresses"||path.startsWith("/driver/deliveries/")||path.startsWith("/merchant/deliveries/")||path.includes("restricted-commerce")||path.endsWith("/purchaser-eligibility")||path.endsWith("/tracking")||path.endsWith("/handoff-code");
    if(!handled && path!=="/store/gospaza/orders/order_fixture/delivery"){await route.fallback();return;}
    const headers={"access-control-allow-origin":req.headers().origin??"http://localhost:3002","access-control-allow-credentials":"true","access-control-allow-headers":"content-type,x-publishable-api-key","access-control-allow-methods":"GET,POST,OPTIONS","cache-control":"private, no-store"};
    const reply=(body:unknown,status=200)=>route.fulfill({headers,status,contentType:"application/json",body:JSON.stringify(body)});
    if(method==="OPTIONS"){await route.fulfill({headers,status:204});return;}
    if(method==="GET")state.reads.push(path);
    if(path==="/merchant/me"){await reply({merchant:{id:"merchant_fixture",trading_name:"Fixture Shop"},store:{id:"store_fixture",name:"Fixture Shop"},membership:{id:"membership_fixture",member_type:role,
      capabilities:["MERCHANT_PORTAL_ACCESS","MERCHANT_RETURN_RECEIVE",...(role==="PICKER"?[]:["MERCHANT_CATALOG_MANAGE","MERCHANT_ORDER_VIEW"])]}});return;}
    if(state.denied||path.includes("foreign")){await reply({},404);return;}
    if(path==="/store/gospaza/orders/order_fixture/delivery"){
      await reply({status:"ASSIGNED",delivery_phase:state.phase});return;
    }
    if(path==="/store/gospaza/checkout/status"){await reply({state:"none",attempt:null,order_id:null,delivery_window:null});return;}
    if(path==="/store/gospaza/addresses"){await reply({addresses:[{id:"address_fixture",address_1:"2 Customer Street",city:"Bloemfontein"}]});return;}
    if(path==="/store/gospaza/cart"){await reply({state:"current",cart:{id:"cart_fixture",store:{id:"store_fixture",name:"Fixture Shop"},items:[{id:"line_fixture",quantity:1}]}});return;}
    if(path==="/store/gospaza/cart/delivery-selection"){await reply({state:"held",revision:1,selection:{id:"hold_fixture",start_at:"2099-01-01T12:00:00Z",end_at:"2099-01-01T13:00:00Z"}});return;}
    if(path==="/store/gospaza/checkout/prepare") {state.writes.push({path,body:req.postDataJSON()});await reply({code:"PURCHASER_VERIFICATION_UNAVAILABLE",message:"private diagnostics"},409);return;}
    if(path==="/merchant/products/product_fixture"){await reply({product:{id:"product_fixture",title:"Fixture wine",description:"750 ml wine",status:"published",requires_age_verification:false,images:[],variants:[{id:"variant_fixture",title:"750 ml",sku:"WINE",price_minor:10000,stocked_quantity:10,reserved_quantity:0,available_quantity:10,currency_code:"zar",inventory_item_id:"inventory_fixture"}]}});return;}
    if(method==="POST"){
      const body=req.postDataJSON();state.writes.push({path,body});await state.gate;state.revision++;
      if(path.endsWith("/recipient")){state.compliance=state.outcome;if(state.outcome==="FAILED"){state.returnState="RETURN_REQUIRED";state.phase="RETURN_REQUIRED";}}
      else if(path.endsWith("/return/start")){state.returnState="RETURNING_TO_STORE";state.phase="RETURNING_TO_STORE";}
      else if(path.endsWith("/return/arrive"))state.arrived=true;
      else if(path.endsWith("/return")){state.returnState="RETURNED_TO_STORE";state.phase="RETURNED_TO_STORE";}
      else if(path.endsWith("/verify"))state.phase="DELIVERED";
      else if(path.includes("/products/"))state.reviewCurrent=true;
      else if(body.action)state.registration=({approve:"ACTIVE",suspend:"SUSPENDED",reactivate:"ACTIVE",revoke:"REVOKED","request-changes":"CHANGES_REQUIRED"} as Record<string,string>)[String(body.action)]!;
      if(state.lost){await route.abort("failed");return;}
      await reply(recipient());return;
    }
    if(path==="/driver/deliveries/current"){await reply({pickup:null});return;}
    if(path==="/driver/deliveries/latest"){await reply({handoff:{delivery_id:"delivery_fixture",revision:state.revision,state:state.phase,compliance_required:state.compliance!=="SATISFIED",restricted_content_present:true,arrived_at:"2026-10-27T10:00:00Z",delivered_at:null}});return;}
    if(path.endsWith("/recipient")){await reply(recipient());return;}
    if(path.endsWith("/document")){await reply({document:{document_number:"INV-42",order_reference:"42",ordered_at:"2026-10-27T08:00:00Z",seller_name:"Fixture Shop",registration_number:"REG-FIXTURE",registration_category:"GROCER_WINE",premises,address:{address_1:"2 Customer Street",city:"Bloemfontein"},goods:[{line_id:"line_fixture",description:"Wine",quantity:1}]}});return;}
    if(path.endsWith("/returns")){await reply({items:state.returnState?[{delivery_id:"delivery_fixture",order_reference:"42",state:state.returnState,awaiting_store_receipt:state.arrived}]:[],more:false});return;}
    if(path.endsWith("/return")){await reply({...recipient(),physical_manifest:[{id:"line_fixture",quantity:2}]});return;}
    if(path.endsWith("/stores")){await reply({items:[{store_id:"store_fixture",name:"Fixture Shop",status:state.registration}],more:false});return;}
    if(path.includes("/products/")){await reply({product_id:"product_fixture",identity_fingerprint:"a".repeat(64),proposed:"NONE",product:{title:"Fixture wine",description:"750 ml wine",variants:[{title:"750 ml",sku:"WINE"}]},review:{id:"review_fixture",restriction:"ALCOHOL",alcohol_class:"WINE",current:state.reviewCurrent}});return;}
    if(path.includes("restricted-commerce")){await reply(registration());return;}
    if(path.endsWith("purchaser-eligibility")){await reply({state:state.purchaser});return;}
    if(path.endsWith("/tracking")){await reply({state:state.phase,tracking:state.returnState?null:{latitude:-29.12345,longitude:26.23456,recorded_at:new Date().toISOString(),expires_at:new Date(Date.now()+120000).toISOString()}});return;}
    if(path.endsWith("/handoff-code")){await reply({state:"UNAVAILABLE",code:null,revision:state.revision,compliance_required:true});return;}
    await reply({},404);
  });return state;
}
async function observations(page:Page, changes:Partial<RecipientObservation>={}) {
  await page.getByRole("combobox",{name:"Recipient",exact:true}).selectOption(changes.recipient_role??"ALTERNATE_ADULT");
  await page.getByRole("combobox",{name:"Document viewed",exact:true}).selectOption(changes.document_type===null?"NONE":changes.document_type??"PASSPORT");
  if(changes.date_of_birth!==null)await page.getByLabel("Observed date of birth").fill(changes.date_of_birth??"1990-01-01");
  for(const [label,value] of [
    ["Acceptable document viewed",changes.document_viewed??true], ["School uniform observed",changes.school_uniform_observed??false],
    ["Recipient declares they are a school-going learner",changes.recipient_declares_school_going_learner??false],
    ["Recipient appears intoxicated",changes.recipient_appears_intoxicated??false], ["Recipient refused verification",changes.recipient_refused_verification??false],
    ["Delivery address matches the invoice",changes.invoice_address_matches??true],
  ] as const)await page.getByRole("combobox",{name:label,exact:true}).selectOption(value?"yes":"no");
}
test("denied recipient read exposes no observations or OTP and sends no mutation",async({page})=>{
  const state=await compliance(page);
  await page.route("http://localhost:9000/driver/deliveries/delivery_fixture/recipient",async route=>{
    if(route.request().method()!=="GET"){await route.fallback();return;}
    await route.fulfill({status:404,contentType:"application/json",headers:{
      "access-control-allow-origin":"http://localhost:3002","access-control-allow-credentials":"true",
    },body:"{}"});
  });
  await page.goto("http://localhost:3002/");
  await expect(page.getByText("Recipient information is unavailable. Refresh before continuing.")).toBeVisible();
  await expect(page.getByRole("button",{name:"Submit recipient observations"})).toHaveCount(0);
  await expect(page.getByLabel("Customer handoff code",{exact:true})).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test("alternate adult observations unlock OTP only after backend success and clear DOB",async({page})=>{
  const state=await compliance(page);await page.goto("http://localhost:3002/");
  await expect(page.getByLabel("Customer handoff code",{exact:true})).toHaveCount(0);
  await observations(page);let release=()=>{};state.gate=new Promise<void>(resolve=>{release=resolve;});
  try {
    await page.getByRole("button",{name:"Submit recipient observations"}).click();
    await expect(page.getByRole("button",{name:"Submit recipient observations"})).toBeDisabled();
    await expect(page.getByLabel("Observed date of birth")).toHaveValue("");
  } finally { release(); }
  await expect(page.getByLabel("Customer handoff code",{exact:true})).toBeVisible();
  expect(state.writes.filter(write=>write.path.endsWith("/recipient"))).toHaveLength(1);
  expect(state.writes[0]!.body.recipient_role).toBe("ALTERNATE_ADULT");expect(state.writes[0]!.body).not.toHaveProperty("compliance_satisfied");
  expect(Object.keys(state.writes[0]!.body).sort()).toEqual([
    "date_of_birth","document_type","document_viewed","expected_revision","invoice_address_matches",
    "recipient_appears_intoxicated","recipient_declares_school_going_learner","recipient_refused_verification",
    "recipient_role","school_uniform_observed",
  ].sort());
  expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage,location.href]))).not.toContain("1990-01-01");
  await page.reload();await expect(page.getByLabel("Customer handoff code",{exact:true})).toBeVisible();
});
for(const [name,input] of [
  ["underage",{date_of_birth:"2020-01-01"}], ["school uniform",{school_uniform_observed:true}],
  ["school-going learner",{recipient_declares_school_going_learner:true}], ["intoxication",{recipient_appears_intoxicated:true}],
  ["refusal",{recipient_refused_verification:true}], ["no document",{document_type:null,document_viewed:false,date_of_birth:null}],
  ["address mismatch",{invoice_address_matches:false}],
] as const)test("backend failed "+name+" requires entire-order return and hides OTP",async({page})=>{
  const state=await compliance(page);state.outcome="FAILED";await page.goto("http://localhost:3002/");await observations(page,input);
  await page.getByRole("button",{name:"Submit recipient observations"}).click();
  await expect(page.getByRole("button",{name:"Start return to store"})).toBeVisible();
  await expect(page.getByLabel("Customer handoff code",{exact:true})).toHaveCount(0);
  await expect(page.getByLabel("Observed date of birth")).toHaveCount(0);
  await page.getByRole("button",{name:"Start return to store"}).click();await page.getByRole("button",{name:"Arrived at original store"}).click();
  await expect(page.getByText(/Awaiting physical receipt acknowledgement/)).toBeVisible();
  await page.reload();await expect(page.getByText(/Awaiting physical receipt acknowledgement/)).toBeVisible();
  expect(state.writes.filter(write=>write.path.endsWith("/recipient"))).toHaveLength(1);
});
test("uncertain recipient response is observed without automatic replay",async({page})=>{
  const state=await compliance(page);state.lost=true;await page.goto("http://localhost:3002/");await observations(page);
  await page.getByRole("button",{name:"Submit recipient observations"}).click();await expect(page.getByLabel("Customer handoff code",{exact:true})).toBeVisible();
  expect(state.writes).toHaveLength(1);
});
test("restricted attention has no OTP or custody escape controls",async({page})=>{
  const state=await compliance(page);state.phase="ATTENTION_REQUIRED";state.compliance="SATISFIED";await page.goto("http://localhost:3002/");
  await expect(page.getByText(/Delivery needs attention. Your assignment remains recorded/)).toBeVisible();
  await expect(page.getByRole("button",{name:/Submit recipient|Confirm handoff|Start return|Arrived at original/})).toHaveCount(0);expect(state.writes).toHaveLength(0);
});
test("driver invoice is bounded and retained for the assigned delivery",async({page})=>{
  await compliance(page);await page.goto("http://localhost:3002/");await page.getByRole("button",{name:"View delivery invoice"}).click();
  const invoice=page.getByRole("region",{name:"Delivery invoice",exact:true});await expect(invoice).toContainText("REG-FIXTURE");await expect(invoice).toContainText("Wine × 1");
  await expect(invoice).not.toContainText("storage_key");await expect(invoice).not.toContainText("evidence_fixture");
});
for(const role of ["OWNER","MANAGER","PICKER"])test(role+" acknowledges physical receipt only",async({page})=>{
  const state=await compliance(page,role);state.returnState="RETURNING_TO_STORE";state.arrived=true;
  await page.goto("http://localhost:3001/merchant/returns");await page.getByRole("button",{name:"Open return for order 42"}).click();
  await page.getByRole("checkbox").check();await page.getByRole("button",{name:"Acknowledge physical receipt"}).click();
  await expect(page.getByText("Physical custody acknowledged. Financial review remains pending.")).toBeVisible();
  expect(state.writes).toEqual([{path:"/merchant/deliveries/delivery_fixture/return",body:{expected_revision:4}}]);
  await expect(page.getByRole("button",{name:"Acknowledge physical receipt"})).toHaveCount(0);
});
test("PICKER cannot administer store registration",async({page})=>{
  const state=await compliance(page,"PICKER");await page.goto("http://localhost:3001/merchant/compliance");
  await expect(page.getByText("You do not have access to store compliance administration.")).toBeVisible();
  expect(state.reads).not.toContain("/merchant/restricted-commerce");expect(state.writes).toHaveLength(0);
});
test("merchant submits existing private evidence for its store only",async({page})=>{
  const state=await compliance(page);await page.goto("http://localhost:3001/merchant/compliance");
  await page.getByRole("button",{name:"Submit for platform review"}).click();
  await expect(page.getByRole("status")).toContainText("Review the current registration");
  expect(state.writes[0]!.body).toEqual({registration_number:"REG-FIXTURE",category:"GROCER_WINE",issuing_authority:"Fixture authority",valid_from:null,valid_until:null,evidence_ids:["evidence_fixture"]});
});
for(const phase of ["RETURN_REQUIRED","RETURNING_TO_STORE","RETURNED_TO_STORE"] as const)test("customer "+phase+" has no coordinates, code or financial resolution claim",async({page})=>{
  const state=await compliance(page);state.phase=phase;state.returnState=phase;await page.goto("http://localhost:3000/orders/order_fixture");
  await expect(page.getByText(/Financial review is pending/)).toBeVisible();
  const expected={
    RETURN_REQUIRED:{title:"Unable to complete restricted delivery",body:"The entire order must be returned to the store."},
    RETURNING_TO_STORE:{title:"Returning to store",body:"Your order is being returned to the store."},
    RETURNED_TO_STORE:{title:"Returned to store",body:"The store has acknowledged physical receipt of your order."},
  }[phase];
  await expect(page.getByRole("region",{name:"Delivery status",exact:true})).toContainText(expected.title);
  await expect(page.getByText(expected.body,{exact:true})).toBeVisible();
  await expect(page.getByText("Financial review is pending. A physical return does not confirm a refund, store credit or total adjustment.",{exact:true})).toBeVisible();
  await expect(page.getByLabel("Courier location")).toHaveCount(0);await expect(page.getByLabel("Handoff code",{exact:true})).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("-29.12345");await expect(page.locator("body")).not.toContainText("school_uniform");
});
for(const action of ["request-changes","suspend","reactivate","revoke"] as const)test("admin store-specific "+action+" requires confirmation and reason",async({page})=>{
  const state=await compliance(page);state.registration=action==="reactivate"?"SUSPENDED":action==="request-changes"?"PENDING_REVIEW":"ACTIVE";
  await page.goto("http://localhost:3003/admin/restricted-commerce");await page.getByRole("button",{name:"Fixture Shop",exact:true}).click();
  await page.getByRole("combobox",{name:"Action",exact:true}).selectOption(action);await page.getByLabel("Reason",{exact:true}).fill("Verified store-specific review");
  await page.getByLabel("Confirm this store-specific decision").check();await page.getByRole("button",{name:"Submit registration decision"}).click();
  await expect(page.getByRole("status")).toContainText("Decision response received");
  expect(state.writes[0]!.body).toEqual({action,expected_revision:4,confirmed:true,reason:"Verified store-specific review"});
});
test("admin classification distinguishes merchant proposal from platform review",async({page})=>{
  const state=await compliance(page);state.reviewCurrent=false;await page.goto("http://localhost:3003/admin/restricted-commerce");await page.getByRole("button",{name:"Fixture Shop",exact:true}).click();
  await page.getByLabel("Native product reference").fill("product_fixture");await page.getByRole("button",{name:"Open product review for this store"}).click();
  await expect(page.getByText("Merchant proposal: NONE",{exact:true})).toBeVisible();await expect(page.getByText(/Reviewed classification: ALCOHOL/)).toBeVisible();
  await page.getByLabel("Reviewed restriction").selectOption("NONE");await page.getByLabel("Review reason").fill("Reviewed downgrade evidence");
  await page.getByLabel("I reviewed the product identity and classification, including any proposed downgrade").check();
  await page.getByRole("button",{name:"Record platform classification"}).click();await expect(page.getByRole("status")).toContainText("Review the current classification");
  expect(state.writes[0]!.body.expected_identity).toBe("a".repeat(64));expect(state.writes[0]!.body).not.toHaveProperty("merchant_id");
});

test("admin approval submits explicit stage windows and store conditions",async({page})=>{
  const state=await compliance(page);await page.goto("http://localhost:3003/admin/restricted-commerce");await page.getByRole("button",{name:"Fixture Shop",exact:true}).click();
  await page.getByRole("combobox",{name:"Action",exact:true}).selectOption("approve");await page.getByLabel("Reason",{exact:true}).fill("Registration and premises reviewed");
  await page.getByLabel("Verified policy source").fill("Verified fixture policy");await page.getByLabel("Policy version").fill("fixture-1");
  await page.getByLabel("Effective from (device local time)").fill("2026-01-01T00:00");await page.getByLabel("WINE",{exact:true}).check();
  for(const name of ["Regulatory sale","Licence sale","Store sale","Dispatch","Handoff"]){
    const group=page.getByRole("group",{name:name+" windows · South African time",exact:true});
    await group.getByRole("button",{name:"Add "+name+" window",exact:true}).click();
    await group.getByRole("combobox",{name:"Day",exact:true}).selectOption("2");await group.getByLabel("Start",{exact:true}).fill("09:00");await group.getByLabel("End",{exact:true}).fill("17:00");
  }
  await page.getByLabel("I verified the registration conditions and stage-specific trading windows for these premises").check();
  await page.getByLabel("Confirm this store-specific decision").check();await page.getByRole("button",{name:"Submit registration decision"}).click();
  await expect(page.getByText("Status: ACTIVE",{exact:true})).toBeVisible();
  expect(state.writes).toHaveLength(1);expect(state.writes[0]!.body.conditions_confirmed).toBe(true);
  expect(state.writes[0]!.body.trading_policy).toMatchObject({timezone:"Africa/Johannesburg",permitted_alcohol_classes:["WINE"],handoff_windows:[{day:2,start_minute:540,end_minute:1020}]});
});

test("private evidence upload is submitted through the protected merchant API",async({page})=>{
  const state=await compliance(page);await page.goto("http://localhost:3001/merchant/compliance");
  await page.getByLabel("Registration evidence",{exact:true}).setInputFiles({name:"licence.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-1.4 fixture")});
  await page.getByRole("button",{name:"Upload private evidence"}).click();await expect(page.getByRole("status")).toContainText("Review the current registration");
  expect(state.writes[0]!.path).toBe("/merchant/restricted-commerce/documents");expect(state.writes[0]!.body.document_type).toBe("LIQUOR_DOCUMENT");
  expect(state.writes[0]!.body).not.toHaveProperty("storage_key");
  await expect(page.getByRole("link",{name:"Licence.pdf",exact:true})).toHaveAttribute("href","http://localhost:9000/merchant/restricted-commerce/documents/evidence_fixture");
});

for(const purchaser of ["UNAVAILABLE","NOT_VERIFIED","EXPIRED","VERIFIED"])test("customer purchaser state "+purchaser+" is backend-derived without identity collection",async({page})=>{
  const state=await compliance(page);state.purchaser=purchaser;await page.goto("http://localhost:3000/checkout");
  const panel=page.getByRole("region",{name:"Restricted purchases",exact:true});
  await expect(panel).toContainText(purchaser==="VERIFIED"?"Purchaser verification confirmed":purchaser==="EXPIRED"?"Purchaser verification has expired":purchaser==="NOT_VERIFIED"?"Purchaser verification is required":"Purchaser verification is currently unavailable");
  await expect(panel).toContainText("Ordinary groceries do not require");await expect(panel.locator("input")).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test("foreign or unavailable return clears receipt data and actions",async({page})=>{
  const state=await compliance(page);state.returnState="RETURNING_TO_STORE";state.arrived=true;await page.goto("http://localhost:3001/merchant/returns");
  await page.getByRole("button",{name:"Open return for order 42"}).click();await expect(page.getByRole("button",{name:"Acknowledge physical receipt"})).toBeVisible();
  state.denied=true;await page.getByRole("button",{name:"Refresh return",exact:true}).click();
  await expect(page.getByText("Return unavailable.",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Acknowledge physical receipt"})).toHaveCount(0);expect(state.writes).toHaveLength(0);
});

test("restricted checkout cannot proceed when backend purchaser verification is unavailable",async({page})=>{
  const state=await compliance(page);await page.goto("http://localhost:3000/checkout");
  await page.getByLabel("Delivery address",{exact:true}).selectOption("address_fixture");await page.getByRole("button",{name:"Review checkout",exact:true}).click();
  await expect(page.getByText("Alcohol purchaser verification is currently unavailable. Restricted checkout cannot proceed.",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Pay securely with Yoco"})).toHaveCount(0);await expect(page.locator("body")).not.toContainText("private diagnostics");
  expect(state.writes).toHaveLength(1);
});

test("merchant NONE proposal cannot visually downgrade the platform ALCOHOL review",async({page})=>{
  const state=await compliance(page);state.reviewCurrent=false;await page.goto("http://localhost:3001/merchant/products/product_fixture");
  const panel=page.getByRole("region",{name:"Restricted product classification",exact:true});
  await expect(panel).toContainText("Platform review: ALCOHOL · Invalidated — new review required");
  await panel.getByLabel("Proposed classification").selectOption("NONE");await panel.getByRole("button",{name:"Propose classification"}).click();
  await expect(panel).toContainText("Platform review: ALCOHOL");expect(state.writes[0]!.body).toEqual({restriction:"NONE",alcohol_class:null});
});

for(const documentType of ["IDENTITY_DOCUMENT","DRIVERS_LICENCE","PASSPORT"] as const)test("purchaser uses supported "+documentType+" observations then native handoff",async({page})=>{
  const state=await compliance(page);await page.goto("http://localhost:3002/");await observations(page,{recipient_role:"PURCHASER",document_type:documentType});
  await page.getByRole("button",{name:"Submit recipient observations"}).click();await page.getByLabel("Customer handoff code",{exact:true}).fill("314159");
  await page.getByRole("button",{name:"Confirm handoff",exact:true}).click();await expect(page.getByText("Delivered",{exact:true})).toBeVisible();
  expect(state.writes.map(write=>write.path)).toEqual(["/driver/deliveries/delivery_fixture/recipient","/driver/deliveries/delivery_fixture/handoff/verify"]);
  expect(state.writes[0]!.body.document_type).toBe(documentType);
});
