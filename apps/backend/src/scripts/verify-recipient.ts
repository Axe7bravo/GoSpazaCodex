import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs, IFileModuleService, IOrderModuleService, IInventoryService, IProductModuleService, IPaymentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import verifyPickup from "./verify-pickup";
import { RestrictedCommerce } from "../lib/restricted-commerce";
import { PickupService } from "../lib/pickup-service";
import { HandoffService } from "../lib/handoff-service";
import { RecipientService, recipientSatisfied } from "../lib/recipient-service";
import { DeliveryTracking } from "../lib/delivery-tracking";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import type { PurchaserEligibilityProvider, PurchaserEvidence } from "../modules/marketplace/restricted-policy";
import type { RecipientInput } from "../modules/marketplace/recipient-policy";

export default async function verifyRecipient(args:ExecArgs) {
  if(!["development","test"].includes(process.env.APP_ENV??"")) throw new Error("Recipient fixtures require a local verification environment.");
  if(process.env.HANDOFF_WORKER_ENABLED==="true") throw new Error("Disable HANDOFF_WORKER_ENABLED in backend and verifier.");
  await verifyPickup(args,async({f,assigned})=>{
    const {container,first}=f.orders.fixture,db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const commerce=new RestrictedCommerce(container),pickup=new PickupService(container),handoff=new HandoffService(container),recipient=new RecipientService(container);
    const native=container.resolve<IOrderModuleService>(Modules.ORDER),inventory=container.resolve<IInventoryService>(Modules.INVENTORY);
    const prior={RESTRICTED_COMMERCE_REVIEWER_IDS:process.env.RESTRICTED_COMMERCE_REVIEWER_IDS,DELIVERY_DOCUMENT_POLICY_APPROVED:process.env.DELIVERY_DOCUMENT_POLICY_APPROVED,DELIVERY_DOCUMENT_POLICY_VERSION:process.env.DELIVERY_DOCUMENT_POLICY_VERSION};
    const customers:string[]=[],evidenceIds:string[]=[];
    let createdFileKey:string|undefined;
    const variants=await container.resolve<IProductModuleService>(Modules.PRODUCT).listProductVariants({id:[first.variantId]},{select:["id","product_id"],take:null});
    const variant=variants[0];assert.ok(variant?.product_id);
    const profile=await db<{medusa_product_id:string}>("product_marketplace_profile").where({merchant_id:first.merchantId,medusa_product_id:variant.product_id}).first();assert.ok(profile);
    const review=async(alcohol:boolean)=>{
      const current=await commerce.classification(f.orders.ownerA.identity,profile.medusa_product_id);
      await commerce.reviewClassification(f.user,first.store.id,profile.medusa_product_id,{restriction:alcohol?"ALCOHOL":"NONE",alcohol_class:alcohol?"WINE":null,
        confirmed:true,reason:"Isolated M17-C fixture",expected_identity:current.identity_fingerprint});
    };
    const observation=(revision:number):RecipientInput=>({expected_revision:revision,recipient_role:"ALTERNATE_ADULT",document_type:"PASSPORT",document_viewed:true,
      date_of_birth:"1990-01-01",school_uniform_observed:false,recipient_declares_school_going_learner:false,recipient_appears_intoxicated:false,
      recipient_refused_verification:false,invoice_address_matches:true});
    async function rejectDeferredCompletion(deliveryId:string,identity:string,message:string) {
      let statementsFinished=false;
      const completionId="delop_"+randomUUID();
      await assert.rejects(pickup.locked(deliveryId,identity,async s=>{
        await s.trx.raw("SET CONSTRAINTS ALL DEFERRED");
        const generation=await s.trx<{id:string}>("handoff_generation").where({delivery_id:deliveryId,state:"ACTIVE"}).forUpdate().first();
        const ship=await s.trx<{id:string}>("pickup_operation").where({delivery_id:deliveryId,action:"SHIP",state:"SUCCEEDED"}).first();
        assert.ok(generation);assert.ok(ship);
        await s.trx("handoff_generation").where({id:generation.id}).update({state:"CONSUMED"});
        // Only GoSpaza rows in this transaction: never dispatch a native workflow.
        // The M16 relationship checks are valid; M17 must reject at COMMIT.
        await s.trx("delivery_completion").insert({id:completionId,delivery_id:deliveryId,commitment_id:s.c.id,
          generation_id:generation.id,ship_operation_id:ship.id,workflow_id:"mark-order-fulfillment-as-delivered-workflow",
          transaction_id:"gospaza-regression-"+randomUUID(),state:"DISPATCHED",dispatched_at:await databaseTime(s.trx)});
        statementsFinished=true;
      }), (error:unknown)=>error instanceof Error&&"code" in error&&error.code==="P0001"&&error.message.endsWith(message));
      assert.equal(statementsFinished,true,"all statements finish; the intended deferred invariant rejects COMMIT");
      assert.equal(await db("delivery_completion").where({id:completionId}).first(),undefined);
      assert.ok(await db("handoff_generation").where({delivery_id:deliveryId,state:"ACTIVE"}).first(),"failed COMMIT rolls back code consumption");
    }
    async function trip(label:string,quantity=1,physical=quantity) {
      try {
        const a=await assigned("recipient-"+label,quantity,physical,false,async person=>{
          customers.push(person.id);await review(true);
          const now=await db.transaction(databaseTime);
          const evidence:PurchaserEvidence={id:"pelig_"+randomUUID(),customer_id:person.id,method:"isolated-recipient-fixture",method_version:"1",policy_version:"fixture-only",
            minimum_age:18,provincial_requirements_satisfied:true,state:"VERIFIED",verified_at:now.toISOString(),expires_at:new Date(now.getTime()+3600000).toISOString()};
          evidenceIds.push(evidence.id);
          const provider:PurchaserEligibilityProvider={async evaluate(){return {state:"VERIFIED",evidence};}};
          await new RestrictedCommerce(container,provider).refreshPurchaser(person.id);return provider;
        });
        assert.ok(await db("restricted_delivery_document").where({medusa_order_id:a.order.orderId}).first(),"document precedes physical pickup");
        await assert.rejects(recipient.verify(a.who.identity,a.delivery.id,observation((await handoff.read(a.who.identity,a.delivery.id)).revision)));
        await pickup.prepare(a.delivery.id);
        const ready=await pickup.read(a.who.identity);assert.equal(ready.pickup?.state,"PICKUP_READY");assert.ok(ready.pickup);
        await pickup.pickup(a.who.identity,a.delivery.id,{expected_revision:ready.pickup.revision});
        await assert.rejects(recipient.verify(a.who.identity,a.delivery.id,observation((await handoff.read(a.who.identity,a.delivery.id)).revision)));
        const moving=await handoff.read(a.who.identity,a.delivery.id);
        await handoff.arrive(a.who.identity,a.delivery.id,{expected_revision:moving.revision});return a;
      } finally {await review(false);}
    }
    try {
      process.env.RESTRICTED_COMMERCE_REVIEWER_IDS=f.user;process.env.DELIVERY_DOCUMENT_POLICY_APPROVED="true";process.env.DELIVERY_DOCUMENT_POLICY_VERSION="isolated-test-document";
      const config=await f.dispatch.configuration(f.user,first.store.id);
      await f.dispatch.configure(f.user,first.store.id,{expected_revision:config.revision,mode:"PLATFORM_ONLY",reason:"M17-C fixture"});
      const file=await commerce.upload(f.orders.ownerA.identity,{document_type:"LIQUOR_DOCUMENT",display_name:"fixture.pdf",mime_type:"application/pdf",
        content:Buffer.from("%PDF-1.4\nM17 fixture\n%%EOF").toString("base64")});
      const uploaded=await db<{storage_key:string}>("restricted_evidence").where({id:file.id,merchant_store_id:first.store.id}).first();assert.ok(uploaded);createdFileKey=uploaded.storage_key;
      const submission=await commerce.submit(f.orders.ownerA.identity,{registration_number:"M17-C-test",category:"GROCER_WINE",issuing_authority:"test-only",valid_from:null,valid_until:null,evidence_ids:[file.id]});assert.ok(submission.registration);
      const windows=Array.from({length:7},(_,day)=>({day,start_minute:0,end_minute:1440}));
      await commerce.reviewRegistration(f.user,first.store.id,{action:"approve",confirmed:true,expected_revision:submission.registration.revision,reason:"M17-C test policy",conditions_confirmed:true,
        trading_policy:{timezone:"Africa/Johannesburg",source:"isolated fixture only",version:"test-1",permitted_alcohol_classes:["WINE"],effective_from:"2020-01-01T00:00:00Z",effective_until:null,
          regulatory_sale_windows:windows,licence_sale_windows:windows,store_sale_windows:windows,dispatch_windows:windows,handoff_windows:windows}});
      const a=await trip("return",5,3),foreign=await f.driver("recipient-foreign");
      // Force the formerly ambiguous completion predicate to be prepared at
      // COMMIT with restricted_content_present=true, even with no completion.
      let validStatementsFinished=false;
      await assert.doesNotReject(pickup.locked(a.delivery.id,a.who.identity,async s=>{
        await s.trx.raw("SET CONSTRAINTS ALL DEFERRED");
        const revision=s.d.revision+1,now=await databaseTime(s.trx);
        await s.trx("delivery_operation").where({id:s.d.id}).update({revision,updated_at:now});
        await s.trx("dispatch_event").insert({id:"dsevt_"+randomUUID(),target_type:"DELIVERY",target_id:s.d.id,revision,
          action:"RECIPIENT_DEFERRED_REGRESSION",actor_type:"system",actor_id:null,occurred_at:now,evidence:JSON.stringify({})});
        validStatementsFinished=true;
      }),"valid restricted delivery and audit must commit through the deferred recipient function");
      assert.equal(validStatementsFinished,true);
      assert.equal((await db("dispatch_event").where({target_id:a.delivery.id,action:"RECIPIENT_DEFERRED_REGRESSION"})).length,1);
      await rejectDeferredCompletion(a.delivery.id,a.who.identity,"Restricted completion requires recipient evidence");
      const before=await handoff.read(a.who.identity,a.delivery.id),input=observation(before.revision);
      // Physical receipt capability never crosses the driver/platform actor boundary.
      await f.http(f.orders.picker.cookie,"POST","/driver/deliveries/"+a.delivery.id+"/recipient",input,401);
      await assert.rejects(commerce.reviewRegistration(f.orders.picker.identity,first.store.id,
        {action:"suspend",confirmed:true,expected_revision:1,reason:"Forbidden picker review"}),{type:MedusaError.Types.FORBIDDEN});
      await assert.rejects(commerce.reviewClassification(f.orders.picker.identity,first.store.id,profile.medusa_product_id,
        {restriction:"NONE",alcohol_class:null,confirmed:true,reason:"Forbidden picker review",expected_identity:"a".repeat(64)}),{type:MedusaError.Types.FORBIDDEN});
      await assert.rejects(recipient.verify(foreign.identity,a.delivery.id,input));
      await f.http(foreign.cookie,"POST","/driver/deliveries/"+a.delivery.id+"/recipient",input,404);
      await f.http(a.order.person.cookie,"POST","/driver/deliveries/"+a.delivery.id+"/recipient",input,401);
      for(const key of ["driver_id","compliance_satisfied","age","merchant_store_id","quantity"])
        await f.http(a.who.cookie,"POST","/driver/deliveries/"+a.delivery.id+"/recipient",{...input,[key]:true},400);
      await f.http(a.who.cookie,"POST","/driver/deliveries/"+a.delivery.id+"/recipient",{...input,document_type:"STUDENT_CARD"},400);
      for(const date_of_birth of ["not-a-date","2999-01-01"])
        await assert.rejects(recipient.verify(a.who.identity,a.delivery.id,{...input,date_of_birth}));
      assert.equal((await db("recipient_compliance").where({delivery_id:a.delivery.id})).length,0);
      const invoice=await recipient.driverDocument(a.who.identity,a.delivery.id);
      assert.equal(invoice.document.goods[0]?.quantity,3);
      const retainedDocument=await db("restricted_delivery_document").where({medusa_order_id:a.order.orderId}).first();
      assert.equal(retainedDocument.snapshot.physical_manifest[0]?.quantity,3);
      for(const field of ["merchant_id","merchant_store_id","registration_id","policy_version","physical_manifest","variant_id","line_id","storage_key","first_name","last_name","phone"])
        assert.equal(JSON.stringify(invoice).includes('"'+field+'"'),false,"transport projection excludes internal evidence identifiers");
      await assert.rejects(recipient.driverDocument(foreign.identity,a.delivery.id));
      assert.deepEqual(await recipient.merchantDocument(f.orders.ownerA.identity,a.order.orderId),invoice);
      await assert.rejects(recipient.merchantDocument(f.orders.ownerB.identity,a.order.orderId));
      await assert.rejects(db("restricted_delivery_document").where({medusa_order_id:a.order.orderId}).update({snapshot:{}}),/Immutable restricted evidence/);
      await assert.rejects(db("restricted_delivery_document").where({medusa_order_id:a.order.orderId}).update({snapshot:JSON.stringify({...retainedDocument.snapshot,address:{...retainedDocument.snapshot.address,city:"forged"}})}),/Immutable restricted evidence/);
      const products=container.resolve<IProductModuleService>(Modules.PRODUCT),product=await products.retrieveProduct(profile.medusa_product_id);
      try {
        await products.updateProducts(profile.medusa_product_id,{title:"Changed after dispatch"});
        assert.deepEqual(await recipient.driverDocument(a.who.identity,a.delivery.id),invoice,"catalogue edits cannot rewrite the retained delivery copy");
      } finally {await products.updateProducts(profile.medusa_product_id,{title:product.title});}
      const code=await handoff.customerCode(a.order.person.id,a.order.orderId);assert.ok(code.code);
      const nativeBefore=await native.retrieveOrder(a.order.orderId,{relations:["items"]});
      const reservationsBefore=await inventory.listReservationItems({line_item_id:(nativeBefore.items??[]).map(i=>i.id)},{take:null});
      const operation=await db<{payment_collection_id:string}>("provider_operation").where({checkout_attempt_id:a.order.attemptId}).first();assert.ok(operation?.payment_collection_id);
      const payments=container.resolve<IPaymentModuleService>(Modules.PAYMENT);
      const financial=()=>payments.retrievePaymentCollection(operation.payment_collection_id,{relations:["payments","payments.captures","payments.refunds"]});
      const financialBefore=await financial();
      const query=container.resolve<{graph(input:{entity:string;fields:string[];filters:Record<string,unknown>}):Promise<{data:unknown[]}>}>(ContainerRegistrationKeys.QUERY);
      const nativeReturns=()=>query.graph({entity:"return",fields:["id","order_id"],filters:{order_id:a.order.orderId}});
      const returnsBefore=await nativeReturns();assert.equal(returnsBefore.data.length,0);
      assert.ok(reservationsBefore.length,"omitted quantities retain their native reservation");
      const levels=()=>inventory.listInventoryLevels({inventory_item_id:reservationsBefore.map(item=>item.inventory_item_id)},{take:null});
      const levelsBefore=await levels();
      const failed={...input,school_uniform_observed:true};
      const races=await Promise.allSettled([recipient.verify(a.who.identity,a.delivery.id,failed),handoff.verify(a.who.identity,a.delivery.id,{expected_revision:before.revision,code:code.code})]);
      assert.equal(races[0]?.status,"fulfilled");assert.equal(races[1]?.status,"rejected");
      let state=await recipient.read(a.who.identity,a.delivery.id);assert.equal(state.return_state,"RETURN_REQUIRED");
      const returnQueue=await recipient.merchantQueue(f.orders.picker.identity,0);
      assert.ok(returnQueue.items.some(item=>item.delivery_id===a.delivery.id));
      assert.ok(returnQueue.items.length<=20);
      assert.equal((await recipient.merchantQueue(f.orders.ownerB.identity,0)).items.some(item=>item.delivery_id===a.delivery.id),false);
      assert.ok(returnQueue.items.every(item=>Object.keys(item).sort().join(",")==="awaiting_store_receipt,delivery_id,order_reference,state"));
      await f.http(f.orders.picker.cookie,"GET","/merchant/deliveries/returns?merchant_id="+first.merchantId,undefined,400);
      await f.http(a.who.cookie,"GET","/merchant/deliveries/returns",undefined,401);
      await f.http(a.order.person.cookie,"GET","/merchant/deliveries/returns",undefined,401);
      await assert.rejects(commerce.reviewQueue(f.orders.picker.identity,0),{type:MedusaError.Types.FORBIDDEN});
      assert.ok((await commerce.reviewQueue(f.user,0)).items.some(item=>item.store_id===first.store.id));
      await rejectDeferredCompletion(a.delivery.id,a.who.identity,"Return authority mismatch");
      assert.equal((await recipient.verify(a.who.identity,a.delivery.id,failed)).compliance,"FAILED");
      for(const field of ["merchant_store_id","quantity","status","driver_id"])
        await assert.rejects(recipient.returnAction(a.who.identity,a.delivery.id,"start",{expected_revision:state.revision,[field]:"forged"}));
      assert.equal((await db("delivery_operation").where({id:a.delivery.id}).first()).handoff_failures,0);
      assert.equal((await db("dispatch_commitment").where({id:a.offer.id}).first()).status,"ASSIGNED");
      await assert.rejects(recipient.verify(a.who.identity,a.delivery.id,input));
      assert.equal((await handoff.customerCode(a.order.person.id,a.order.orderId)).code,null);
      assert.equal((await new DeliveryTracking(container).customer(a.order.person.id,a.order.orderId)).tracking,null);
      await assert.rejects(recipient.merchant(f.orders.ownerB.identity,a.delivery.id,{expected_revision:state.revision}));
      await f.http(f.orders.picker.cookie,"POST","/merchant/deliveries/"+a.delivery.id+"/return",{expected_revision:state.revision,compliance_satisfied:true},400);
      await assert.rejects(recipient.merchant(f.orders.ownerA.identity,a.delivery.id,{expected_revision:state.revision}));
      state=await recipient.returnAction(a.who.identity,a.delivery.id,"start",{expected_revision:state.revision});
      const arrival={expected_revision:state.revision};
      const arrivalRace=await Promise.allSettled([recipient.returnAction(a.who.identity,a.delivery.id,"arrive",arrival),
        recipient.returnAction(a.who.identity,a.delivery.id,"arrive",arrival),recipient.merchant(f.orders.picker.identity,a.delivery.id,arrival)]);
      assert.equal(arrivalRace[0]?.status,"fulfilled");assert.equal(arrivalRace[1]?.status,"fulfilled");
      assert.equal(arrivalRace[2]?.status,"rejected","receipt cannot use pre-arrival revision regardless of lock winner");
      state=await recipient.read(a.who.identity,a.delivery.id);assert.equal(state.awaiting_store_receipt,true);
      assert.equal((await db("dispatch_commitment").where({id:a.offer.id}).first()).status,"ASSIGNED");
      class AuditFailure extends RecipientService {
        override async event(...params:Parameters<RecipientService["event"]>) {
          if(params[2]==="STORE_RECEIPT_ACKNOWLEDGED") throw new Error("Injected receipt audit failure");
          return super.event(...params);
        }
      }
      await assert.rejects(new AuditFailure(container).merchant(f.orders.ownerA.identity,a.delivery.id,{expected_revision:state.revision}),/Injected receipt audit failure/);
      assert.equal((await db("dispatch_commitment").where({id:a.offer.id}).first()).status,"ASSIGNED");
      await Promise.all([recipient.merchant(f.orders.picker.identity,a.delivery.id,{expected_revision:state.revision}),
        recipient.merchant(f.orders.manager.identity,a.delivery.id,{expected_revision:state.revision}),handoff.observe(a.delivery.id)]);
      assert.equal((await recipient.read(a.who.identity,a.delivery.id)).return_state,"RETURNED_TO_STORE");
      assert.equal((await db("dispatch_commitment").where({id:a.offer.id}).first()).status,"RETURNED");
      assert.equal((await db("dispatch_event").where({target_id:a.delivery.id,action:"RETURNED_TO_STORE"})).length,1);
      assert.equal(await db("dispatch_commitment").where({driver_profile_id:a.who.id}).whereIn("status",["OFFERED","ASSIGNED"]).first(),undefined);
      await assert.rejects(db("delivery_operation").where({id:a.delivery.id}).update({status:"DELIVERED",revision:db.raw("revision + 1")}),/Terminal delivery/);
      await assert.rejects(db("restricted_return").where({delivery_id:a.delivery.id}).update({merchant_store_id:f.orders.fixture.second.store.id}),/Immutable return custody/);
      await recipient.merchant(f.orders.ownerA.identity,a.delivery.id,{expected_revision:state.revision});
      assert.equal((await db("delivery_completion").where({delivery_id:a.delivery.id})).length,0);
      assert.deepEqual(await native.retrieveOrder(a.order.orderId,{relations:["items"]}),nativeBefore);
      assert.deepEqual(await inventory.listReservationItems({line_item_id:(nativeBefore.items??[]).map(i=>i.id)},{take:null}),reservationsBefore);
      assert.deepEqual(await levels(),levelsBefore);
      assert.deepEqual(await financial(),financialBefore);
      assert.deepEqual(await nativeReturns(),returnsBefore);
      await assert.rejects(handoff.verify(a.who.identity,a.delivery.id,{expected_revision:state.revision,code:code.code}));
      const b=await trip("success"),bview=await handoff.read(b.who.identity,b.delivery.id),binput=observation(bview.revision);
      assert.equal((await recipient.verify(b.who.identity,b.delivery.id,binput)).compliance,"SATISFIED");
      await pickup.locked(b.delivery.id,b.who.identity,async s=>{
        assert.equal(await recipientSatisfied(s,"foreign_or_superseded_generation"),false);
      });
      await assert.rejects(recipient.verify(b.who.identity,b.delivery.id,{...binput,recipient_appears_intoxicated:true}));
      const bcode=await handoff.customerCode(b.order.person.id,b.order.orderId);assert.ok(bcode.code);
      await assert.doesNotReject(async()=>{
        assert.equal((await handoff.verify(b.who.identity,b.delivery.id,{expected_revision:bcode.revision,code:bcode.code})).state,"DELIVERED");
      },"matching SATISFIED recipient evidence permits restricted completion transactions to commit");
      assert.equal((await db("restricted_return").where({delivery_id:b.delivery.id})).length,0);
      const c=await trip("race"),cinput=observation((await handoff.read(c.who.identity,c.delivery.id)).revision);
      const outcomes=await Promise.allSettled([recipient.verify(c.who.identity,c.delivery.id,cinput),recipient.verify(c.who.identity,c.delivery.id,{...cinput,recipient_declares_school_going_learner:true})]);
      assert.equal(outcomes.filter(v=>v.status==="fulfilled").length,1);
      assert.equal((await db("recipient_compliance").where({delivery_id:c.delivery.id})).length,1);
      const d=await trip("licence-change"),dinput=observation((await handoff.read(d.who.identity,d.delivery.id)).revision);
      await recipient.verify(d.who.identity,d.delivery.id,dinput);
      const dcode=await handoff.customerCode(d.order.person.id,d.order.orderId);assert.ok(dcode.code);
      const licence=await commerce.registration(f.orders.ownerA.identity);
      assert.ok(licence.registration);
      await commerce.reviewRegistration(f.user,first.store.id,{action:"suspend",confirmed:true,expected_revision:licence.registration.revision,reason:"In-transit test suspension"});
      await assert.rejects(handoff.verify(d.who.identity,d.delivery.id,{expected_revision:dcode.revision,code:dcode.code}));
      assert.equal((await db("delivery_operation").where({id:d.delivery.id}).first()).status,"ATTENTION_REQUIRED");
      assert.equal((await db("dispatch_commitment").where({id:d.offer.id}).first()).status,"ASSIGNED");
      assert.equal((await db("recipient_compliance").where({delivery_id:d.delivery.id}).first()).outcome,"SATISFIED");
      assert.equal((await db("delivery_completion").where({delivery_id:d.delivery.id})).length,0);
      const suspended=await commerce.registration(f.orders.ownerA.identity);assert.ok(suspended.registration);
      await commerce.reviewRegistration(f.user,first.store.id,{action:"reactivate",confirmed:true,expected_revision:suspended.registration.revision,reason:"Isolated race fixture restoration"});
      const e=await trip("licence-otp-race"),einput=observation((await handoff.read(e.who.identity,e.delivery.id)).revision);
      await recipient.verify(e.who.identity,e.delivery.id,einput);
      const ecode=await handoff.customerCode(e.order.person.id,e.order.orderId);assert.ok(ecode.code);
      const active=await commerce.registration(f.orders.ownerA.identity);assert.ok(active.registration);
      const licenceRace=await Promise.allSettled([
        commerce.reviewRegistration(f.user,first.store.id,{action:"suspend",confirmed:true,expected_revision:active.registration.revision,reason:"Concurrent licence invalidation"}),
        handoff.verify(e.who.identity,e.delivery.id,{expected_revision:ecode.revision,code:ecode.code}),
      ]);
      assert.equal(licenceRace[0]?.status,"fulfilled");
      const terminal=await db("delivery_operation").where({id:e.delivery.id}).first();
      const commitment=await db("dispatch_commitment").where({id:e.offer.id}).first();
      if(licenceRace[1]?.status==="fulfilled") {
        assert.equal(terminal.status,"DELIVERED");assert.equal(commitment.status,"COMPLETED");
        assert.equal((await db("delivery_completion").where({delivery_id:e.delivery.id,state:"SUCCEEDED"})).length,1);
      } else {
        assert.equal(terminal.status,"ATTENTION_REQUIRED");assert.equal(commitment.status,"ASSIGNED");
        assert.equal((await db("delivery_completion").where({delivery_id:e.delivery.id})).length,0);
      }
      assert.equal((await db("restricted_return").where({delivery_id:e.delivery.id})).length,0,"licence loss cannot reinterpret a won SATISFIED result as physical return");
      const rows=await db("recipient_compliance").whereIn("delivery_id",[a.delivery.id,b.delivery.id,c.delivery.id,d.delivery.id,e.delivery.id]);
      const events=await db("restricted_event").whereIn("target_id",rows.map(r=>r.id));
      for(const value of [...rows,...events])for(const prohibited of ["1990-01-01","date_of_birth","document_number","latitude","longitude"])
        assert.equal(JSON.stringify(value).includes(prohibited),false);
    } finally {
      const orders=customers.length?await native.listOrders({customer_id:customers},{take:null}):[];
      const orderIds=orders.map(o=>o.id),deliveries=await db<{id:string}>("delivery_operation").whereIn("medusa_order_id",orderIds);
      await db.transaction(async trx=>{
        await trx("restricted_return").whereIn("delivery_id",deliveries.map(d=>d.id)).delete();
        await trx("recipient_compliance").whereIn("delivery_id",deliveries.map(d=>d.id)).delete();
        await trx("restricted_delivery_document").whereIn("medusa_order_id",orderIds).delete();
      });
      if(evidenceIds.length)await db("purchaser_eligibility").whereIn("id",evidenceIds).delete();
      await review(false);
      if(createdFileKey)await container.resolve<IFileModuleService>(Modules.FILE).deleteFiles(createdFileKey);
      for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    }
  });
  console.log("M17-C recipient and physical return verification passed.");
}
