import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile,writeFile } from "node:fs/promises";
import { dirname,join } from "node:path";
import type { ExecArgs,IAuthModuleService } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { CommissionService } from "../lib/commission-service";
import { MarketplaceRecognition } from "../lib/marketplace-recognition";
import { OrderEconomics } from "../lib/order-economics";
import { commissionActorFile,commissionFixturePassword } from "./fixtures/commission-actors";
import { withRetainedRecognitionFixture } from "./fixtures/financial-browser";
import verifyRecipient from "./verify-recipient";

export default async function verifyCommissionSurfaces(args:ExecArgs) {
  const actors=JSON.parse(await readFile(commissionActorFile,"utf8"));
  const base=new URL(process.env.BACKEND_URL??"");
  commissionFixturePassword(actors.writer.email);
  let order="",merchant="";
  const manifestFile=join(dirname(commissionActorFile),"m19-surfaces-"+randomUUID()+".json");
  let manifest:object|undefined;
  await withRetainedRecognitionFixture(async()=>{
    async function signIn(email:string) {
      const login=await fetch(new URL("/auth/user/emailpass",base),{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email,password:commissionFixturePassword(email)})});
      assert.equal(login.status,200);
      const {token}=await login.json() as {token:string};
      const session=await fetch(new URL("/auth/session",base),{method:"POST",headers:{Authorization:"Bearer "+token}});
      assert.equal(session.status,200);
      const cookie=session.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");assert.ok(cookie);return cookie;
    }
    const writer=await signIn(actors.writer.email),viewer=await signIn(actors.viewer.email);
    const rules="/admin/gospaza/commission-rules";
    const decision=()=>({scope:"MERCHANT",merchant_id:merchant,decision:"SET",basis_points:800,confirmed:true,
      reason:"Disposable order terms",expected_revision:0,request_id:randomUUID()});
    try {
      await verifyRecipient(args,async(f,_delivery,zero,_returns,driverCookie)=>{
        const {container}=f.fixture;
        await new CommissionService(container).ensure(order);
        assert.equal((await new MarketplaceRecognition(container).recognize(order)).state,"RECOGNIZED");
        const path="/merchant/orders/"+order+"/economics", adminPath="/admin/gospaza/orders/"+order+"/finance-snapshot";
        const get=async(cookie:string,path:string,status=200)=>f.expect(await f.http(cookie,"GET",path),status);
        const admin=await get(viewer,adminPath) as {state:string;basis_points:number;earned:{commission_minor:number};exceptions:unknown[]};
        assert.equal(admin.state,"EARNED");assert.equal(admin.basis_points,800);
        for(const hidden of ["source_fingerprint","native_economics_fingerprint","actor_id","request_id","account_id","completion_id","units"])
          assert.equal(JSON.stringify(admin).includes('"'+hidden+'"'),false);
        assert.equal((await get(viewer,"/admin/gospaza/orders/"+zero+"/finance-snapshot") as {state:string}).state,"KNOWN_ZERO");
        const read=await get(f.ownerA.cookie,path) as Record<string,unknown>;
        assert.deepEqual(Object.keys(read).sort(),["order_id","currency","state","basis_points","zero_reason","earned"].sort());
        assert.deepEqual(Object.keys(read.earned as object).sort(),["merchandise_minor","tax_minor","subsidy_minor","basis_minor","commission_minor","entitlement_minor","economic_at"].sort());
        assert.deepEqual(read.earned,admin.earned);assert.deepEqual(await get(f.manager.cookie,path),read);
        await get(f.picker.cookie,path,403);
        assert.deepEqual(await get(f.ownerB.cookie,path,404),await get(f.ownerB.cookie,"/merchant/orders/order_unknown/economics",404));
        await get(f.ownerA.cookie,path+"?store_id=foreign",400);
        for(const cookie of [f.a.person.cookie,driverCookie]) {
          await get(cookie,path,401);await get(cookie,adminPath,401);await get(cookie,rules,401);
        }
        for(const data of [await get(f.a.person.cookie,"/store/gospaza/orders/"+f.a.orderId+"/financial-resolution"),
          await get(driverCookie,"/driver/deliveries/latest")]) {
          for(const hidden of ["basis_points","commission_minor","entitlement_minor","posting","exceptions","rule_revision"])
            assert.equal(JSON.stringify(data).includes('"'+hidden+'"'),false);
        }
        await get(f.ownerA.cookie,rules+"?merchant_id="+f.fixture.second.merchantId,401);
        await get(f.platform.cookie,rules,403);
        for(const [cookie,allowed] of [[writer,true],[viewer,false]] as const) {
          const h=await get(cookie,rules+"?merchant_id="+merchant) as {can_publish:boolean;items:Record<string,unknown>[]};
          assert.equal(h.can_publish,allowed);
          assert.ok(h.items.some(row=>row.basis_points===800 && row.timing==="CURRENT"));
          for(const row of h.items) assert.deepEqual(Object.keys(row).sort(),
            ["id","merchant_id","decision","basis_points","revision","effective_at","recorded_at","reason","timing"].sort());
        }
        await get(writer,adminPath,403);await get(f.platform.cookie,adminPath,403);
        // The server allowlist is environment-backed. Exercise removal in this
        // verifier process without restarting or changing the shared HTTP server.
        const previousView=process.env.FINANCIAL_VIEW_USER_IDS;
        try {
          const access=new OrderEconomics(container);
          process.env.FINANCIAL_VIEW_USER_IDS=actors.viewer.id;
          assert.equal((await access.platform(actors.viewer.id,order)).state,"EARNED");
          delete process.env.FINANCIAL_VIEW_USER_IDS;
          await assert.rejects(access.platform(actors.viewer.id,order),e=>!!e && typeof e==="object" && "type" in e && e.type==="forbidden");
        } finally {
          if(previousView===undefined) delete process.env.FINANCIAL_VIEW_USER_IDS;else process.env.FINANCIAL_VIEW_USER_IDS=previousView;
        }
        for(const cookie of [viewer,f.platform.cookie]) f.expect(await f.http(cookie,"POST",rules,decision()),403);
        f.expect(await f.http(writer,"POST",rules,{...decision(),expected_revision:1,effective_at:"2000-01-01T00:00:00Z"}),409);
        f.expect(await f.http(writer,"POST",rules,{...decision(),commission_minor:10}),400);
        f.expect(await f.http(writer,"POST","/admin/gospaza/financial-adjustments/fadj_known/store-credit",{confirmed:true}),403);
        f.expect(await f.http(writer,"POST","/admin/gospaza/financial-adjustments/fadj_known/refund",
          {action:"EXECUTE",reason:"APPROVED_ADJUSTMENT",confirmed:true}),403);
        f.expect(await f.http(writer,"POST","/admin/gospaza/financial-adjustments/fadj_known/approve",{expected_revision:1,confirmed:true}),403);
        const membership="/merchant/team/members/"+f.manager.id;
        f.expect(await f.http(f.ownerA.cookie,"PATCH",membership,{status:"INACTIVE"}));
        try {await get(f.manager.cookie,path,401);} finally {f.expect(await f.http(f.ownerA.cookie,"PATCH",membership,{status:"ACTIVE"}));}
        const auth=container.resolve<IAuthModuleService>(Modules.AUTH);
        async function email(id:string) {
          const record=await auth.retrieveAuthIdentity(id,{relations:["provider_identities"]});
          const name=record.provider_identities?.find(v=>v.provider==="emailpass")?.entity_id;assert.ok(name?.endsWith("@example.test"));return name;
        }
        manifest={version:1,order,zero,writeMerchant:f.fixture.second.merchantId,owner:await email(f.ownerA.identity),
          picker:await email(f.picker.identity),foreign:await email(f.ownerB.identity),viewer:actors.viewer.email,writer:actors.writer.email};
      },{
        async beforeOrder(_user,id) {
          merchant=id;
          const res=await fetch(new URL(rules,base),{method:"POST",headers:{"Content-Type":"application/json",Cookie:writer},
            body:JSON.stringify(decision())});assert.equal(res.status,200);
        },
        async beforeDelivery(id){order=id;},
      });
    } finally {
      for(const cookie of [writer,viewer]) await fetch(new URL("/auth/session",base),{method:"DELETE",headers:{Cookie:cookie}});
    }
  },process.env.M19_VERIFY_SECRET);
  assert.ok(manifest);await writeFile(manifestFile,JSON.stringify(manifest),{flag:"wx"});
  console.log("M19-D direct API checks passed. Isolated browser manifest: "+manifestFile);
}
