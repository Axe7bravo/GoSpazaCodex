import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import verifyMerchantSettlements from "./verify-merchant-settlements";
import { MerchantPayouts } from "../lib/merchant-payout-service";
import { reconcilePayout } from "../modules/marketplace/merchant-payout-policy";

const domain=(type:string)=>(error:unknown)=>!!error && typeof error==="object" && "type" in error && error.type===type;
const decision=(revision:number)=>({request_id:"m20c_"+randomUUID(),expected_revision:revision,confirmed:true,reason:"Reviewed isolated external transfer evidence"});
export default async function verifyMerchantPayouts(args:ExecArgs) {
  if(process.env.APP_ENV!=="test" || !new URL(process.env.DATABASE_URL??"").pathname.endsWith("_test"))
    throw new Error("Use test:isolated with an existing _test database.");
  const base=args.container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  assert.ok(await base.schema.hasTable("merchant_payout_receipt"),"Apply the M20-C forward migration first.");
  await verifyMerchantSettlements(args,async({db,actor_id:actor,makeReady})=>{
    const grants=["SETTLEMENT_APPROVE_USER_IDS","SETTLEMENT_PAYOUT_RECORD_USER_IDS","SETTLEMENT_RECONCILE_USER_IDS"];
    const original=grants.map(k=>process.env[k]);
    const service=new MerchantPayouts(args.container,db);
    const row=(payable:string)=>db("payable_settlement").where({id:payable}).first();
    const give=(...names:string[])=>{for(const k of grants) {if(names.includes(k)) process.env[k]=actor;else delete process.env[k];}};
    const all=()=>give(...grants);
    const transfer=async()=>{
      const {rows:[clock]}=await db.raw("select clock_timestamp() as instant");
      return {amount_minor:9000,currency:"zar",beneficiary_reference:"verified_beneficiary_private",
        channel:"BANK_TRANSFER",origin_reference:"origin_private",external_transfer_id:"bank_"+randomUUID(),
        transferred_at:new Date(clock.instant).toISOString(),evidence_reference:"bank_evidence_private"};
    };
    const review=(e:Awaited<ReturnType<typeof transfer>>,receipt_id:string,revision:number,review_reference:string)=>{
      // Reconciliation matches transfer facts; payout-only evidence_reference
      // and the payout command's request/revision must not be copied into it.
      const input={...decision(revision),receipt_id,review_reference,amount_minor:e.amount_minor,currency:e.currency,
        beneficiary_reference:e.beneficiary_reference,transferred_at:e.transferred_at,channel:e.channel,
        origin_reference:e.origin_reference,external_transfer_id:e.external_transfer_id};
      assert.ok(reconcilePayout.safeParse(input).success,"Reconciliation fixture must satisfy the strict command shape before testing domain conflicts.");
      return input;
    };
    const approve=async(name:string)=>{const payable=await makeReady(name);await service.execute(actor,payable,"APPROVE",decision(1));return payable;};
    const count=async(table:string,payable:string)=>Number((await db(table).where({payable_id:payable}).count("* as total").first())?.total??0);
    const assertContender=(result:PromiseSettledResult<unknown>)=>{
      if(result.status==="rejected") assert.ok(domain("conflict")(result.reason),"Only an explicit settlement conflict is a legitimate loser.");
    };
    try {
      const first=await makeReady("c_primary");give();
      await assert.rejects(service.execute(actor,first,"APPROVE",decision(1)),domain("forbidden"));
      await assert.rejects(service.evidence(actor,first),domain("forbidden"));
      give("SETTLEMENT_APPROVE_USER_IDS");
      await assert.rejects(service.execute(actor,first,"PAY",{...decision(1),...await transfer()}),domain("forbidden"));
      give("SETTLEMENT_PAYOUT_RECORD_USER_IDS");
      await assert.rejects(service.execute(actor,first,"RECONCILE",decision(1)),domain("forbidden"));
      all();
      await assert.rejects(service.execute(actor,first,"APPROVE",{...decision(1),amount_minor:1}),domain("invalid_data"));
      const approval=decision(1);
      const approvals=await Promise.all([service.execute(actor,first,"APPROVE",approval),service.execute(actor,first,"APPROVE",approval)]);
      assert.deepEqual(approvals[0],approvals[1]);assert.equal(await count("merchant_settlement_command",first),1);
      assert.equal((await row(first)).status,"APPROVED");assert.equal((await row(first)).revision,2);
      await assert.rejects(service.execute(actor,first,"APPROVE",{...approval,reason:"Changed replay"}),domain("conflict"));
      await assert.rejects(service.execute(actor,first,"APPROVE",decision(1)),domain("conflict"));
      const originalStatement=await db("merchant_period_statement").where({id:(await row(first)).statement_id}).first();
      const originalItems=await db("settlement_item").where({statement_id:originalStatement.id}).orderBy("posting_id");
      const payment={...decision(2),...await transfer()};
      for(const amount_minor of [8999,9001]) await assert.rejects(service.execute(actor,first,"PAY",{...payment,request_id:"bad_"+randomUUID(),amount_minor}),domain("conflict"));
      await assert.rejects(service.execute(actor,first,"PAY",{...payment,currency:"usd"}),domain("invalid_data"));
      await assert.rejects(service.execute(actor,first,"PAY",{...payment,transferred_at:"2000-01-01T00:00:00Z"}),domain("conflict"));
      await assert.rejects(service.execute(actor,first,"PAY",{...payment,transferred_at:"2099-01-01T00:00:00Z"}),domain("conflict"));
      assert.equal(await count("merchant_payout_receipt",first),0);
      const paid=await Promise.all([service.execute(actor,first,"PAY",payment),service.execute(actor,first,"PAY",payment)]);
      assert.deepEqual(paid[0],paid[1]);assert.ok(paid[0]?.receipt_id);assert.equal(await count("merchant_payout_receipt",first),1);
      assert.equal(await count("merchant_payout_identity",first),1);
      await assert.rejects(service.execute(actor,first,"PAY",{...payment,external_transfer_id:"changed_bank_id"}),domain("conflict"));
      await assert.rejects(service.execute(actor,first,"PAY",{...decision(3),...await transfer()}),domain("conflict"));
      const ordinary=JSON.stringify(await service.read(actor,first));
      for(const secret of [payment.beneficiary_reference,payment.origin_reference,payment.external_transfer_id,payment.evidence_reference,"request_fingerprint","identity_id"])
        assert.ok(!ordinary.includes(secret),"Ordinary VIEW projection must omit private payout evidence.");
      const reconciliation=review(payment,paid[0]!.receipt_id,3,"review_matched");
      await assert.rejects(service.execute(actor,first,"RECONCILE",{...reconciliation,beneficiary_reference:"wrong_beneficiary"}),domain("conflict"));
      await assert.rejects(service.execute(actor,first,"RECONCILE",{...reconciliation,external_transfer_id:"wrong_transfer"}),domain("conflict"));
      const reconciled=await Promise.all([service.execute(actor,first,"RECONCILE",reconciliation),service.execute(actor,first,"RECONCILE",reconciliation)]);
      assert.deepEqual(reconciled[0],reconciled[1]);assert.equal((await row(first)).status,"RECONCILED");
      await assert.rejects(service.execute(actor,first,"RECONCILE",{...reconciliation,reason:"Changed review"}),domain("conflict"));
      await assert.rejects(db("payable_settlement").where({id:first}).update({status:"APPROVED",revision:5}),/Unproven payable transition/);
      await assert.rejects(db("payable_settlement").where({id:first}).update({amount_minor:1}),/Immutable payable economics/);
      await assert.rejects(db("merchant_payout_receipt").where({payable_id:first}).delete(),/Immutable M20/);
      assert.deepEqual(await db("merchant_period_statement").where({id:originalStatement.id}).first(),originalStatement);
      assert.deepEqual(await db("settlement_item").where({statement_id:originalStatement.id}).orderBy("posting_id"),originalItems);
      assert.equal((await db("settlement_source_claim").where({posting_id:originalItems[0].posting_id}).first()).statement_id,originalStatement.id);

      // Different requests may race, but only one approval transition may exist.
      const competingApproval=await makeReady("c_approve_race");
      const approvalRace=await Promise.allSettled([service.execute(actor,competingApproval,"APPROVE",decision(1)),service.execute(actor,competingApproval,"APPROVE",decision(1))]);
      approvalRace.forEach(assertContender);assert.equal(approvalRace.filter(r=>r.status==="fulfilled").length,1);
      assert.equal(await count("merchant_settlement_command",competingApproval),1);
      const held=await makeReady("c_fresh_hold");
      await db("order_finance_exception").insert({id:"c_new_finance_hold",snapshot_id:"c_fresh_hold_posting_snapshot",reason:"POSTING_SOURCE_CONFLICT"});
      await assert.rejects(service.execute(actor,held,"APPROVE",decision(1)),/Settlement preparation consistency/);
      assert.equal((await row(held)).status,"READY_FOR_APPROVAL");assert.equal(await count("merchant_settlement_command",held),0);

      const admission=await makeReady("c_approve_pay_race"),admissionTransfer=await transfer();
      const admissionRace=await Promise.allSettled([service.execute(actor,admission,"APPROVE",decision(1)),
        service.execute(actor,admission,"PAY",{...decision(1),...admissionTransfer})]);
      admissionRace.forEach(assertContender);assert.equal(admissionRace[0]?.status,"fulfilled");assert.equal(admissionRace[1]?.status,"rejected");
      assert.equal((await row(admission)).status,"APPROVED");assert.equal(await count("merchant_payout_receipt",admission),0);

      // Same external transfer cannot pay two different merchants, even concurrently.
      const bankA=await approve("c_bank_a"),bankB=await approve("c_bank_b"),sharedTransfer=await transfer();
      const bankRace=await Promise.allSettled([service.execute(actor,bankA,"PAY",{...decision(2),...sharedTransfer}),service.execute(actor,bankB,"PAY",{...decision(2),...sharedTransfer})]);
      bankRace.forEach(assertContender);assert.equal(bankRace.filter(r=>r.status==="fulfilled").length,1);
      assert.equal(await count("merchant_payout_receipt",bankA)+await count("merchant_payout_receipt",bankB),1);
      for(const payable of [bankA,bankB]) {
        const current=await row(payable);
        if(current.status==="APPROVED") {
          assert.equal(current.revision,2);assert.equal(await count("merchant_settlement_command",payable),1);
          await assert.rejects(service.execute(actor,payable,"PAY",{...decision(2),...sharedTransfer,amount_minor:9001}),domain("conflict"));
          await assert.rejects(service.execute(actor,payable,"PAY",payment),domain("conflict"));
          assert.equal(await count("merchant_payout_receipt",payable),0);
        }
      }
      const recorders=await approve("c_two_recorders"),recorderTransferA=await transfer(),recorderTransferB=await transfer();
      const recorderRace=await Promise.allSettled([service.execute(actor,recorders,"PAY",{...decision(2),...recorderTransferA}),
        service.execute(actor,recorders,"PAY",{...decision(2),...recorderTransferB})]);
      recorderRace.forEach(assertContender);assert.equal(recorderRace.filter(r=>r.status==="fulfilled").length,1);
      assert.equal(await count("merchant_payout_receipt",recorders),1);assert.equal(await count("merchant_payout_identity",recorders),1);

      const failed=await approve("c_failed"),failureTime=await transfer();
      const failure={...decision(2),channel:failureTime.channel,origin_reference:failureTime.origin_reference,
        external_transfer_id:failureTime.external_transfer_id,beneficiary_reference:failureTime.beneficiary_reference,
        attempted_at:failureTime.transferred_at,failure_category:"BANK_REJECTED",nonreceipt_confirmed:true,evidence_reference:"bank_nonreceipt"};
      await assert.rejects(service.execute(actor,failed,"FAIL",{...failure,failure_category:"HTTP_TIMEOUT"}),domain("invalid_data"));
      await assert.rejects(service.execute(actor,failed,"FAIL",{...failure,nonreceipt_confirmed:false}),domain("invalid_data"));
      const failureResult=await service.execute(actor,failed,"FAIL",failure);assert.ok(failureResult.failed_attempt_id);
      assert.equal((await row(failed)).status,"FAILED");assert.equal(await count("merchant_payout_receipt",failed),0);
      assert.deepEqual(await service.execute(actor,failed,"FAIL",failure),failureResult);
      const failedRecord=await db("merchant_payout_failure").where({id:failureResult.failed_attempt_id}).first();
      const retry={...decision(3),failed_attempt_id:failureResult.failed_attempt_id,review_reference:"reviewed_failure"};
      await assert.rejects(service.execute(actor,failed,"RETRY",{...retry,failed_attempt_id:"unknown_failure"}),domain("conflict"));
      const retryRace=await Promise.allSettled([service.execute(actor,failed,"RETRY",retry),service.execute(actor,failed,"PAY",{...decision(3),...await transfer()})]);
      retryRace.forEach(assertContender);assert.equal(retryRace[0]?.status,"fulfilled");assert.equal(retryRace[1]?.status,"rejected");
      assert.equal((await row(failed)).status,"APPROVED");assert.equal((await row(failed)).revision,4);
      await assert.rejects(service.execute(actor,failed,"PAY",{...decision(4),...await transfer(),external_transfer_id:failure.external_transfer_id}),domain("conflict"));
      await service.execute(actor,failed,"PAY",{...decision(4),...await transfer()});
      assert.deepEqual(await db("merchant_payout_failure").where({id:failureResult.failed_attempt_id}).first(),failedRecord);
      assert.equal(await count("merchant_payout_receipt",failed),1);

      const ambiguous=await approve("c_unknown");
      await service.execute(actor,ambiguous,"DISCREPANCY",{...decision(2),category:"UNKNOWN_OUTCOME",evidence_reference:"bank_enquiry"});
      assert.equal((await row(ambiguous)).status,"APPROVED");
      await assert.rejects(service.execute(actor,ambiguous,"PAY",{...decision(2),...await transfer()}),domain("conflict"));
      const disputed=await approve("c_disputed"),disputedTransfer=await transfer();
      const disputedReceipt=await service.execute(actor,disputed,"PAY",{...decision(2),...disputedTransfer});
      const dispute={...decision(3),category:"RETURNED_TRANSFER",evidence_reference:"bank_return_notice"};
      await service.execute(actor,disputed,"DISCREPANCY",dispute);
      assert.equal((await row(disputed)).status,"PAID");assert.equal(await count("merchant_payout_receipt",disputed),1);
      await assert.rejects(service.execute(actor,disputed,"RECONCILE",review(disputedTransfer,disputedReceipt.receipt_id,3,"review")),domain("conflict"));
      await assert.rejects(db("merchant_settlement_discrepancy").where({payable_id:disputed}).update({status:"CLOSED"}),/Immutable M20/);

      // Failure and success assertions compete on the same approved revision.
      const outcome=await approve("c_outcome_race"),outcomeTime=await transfer();
      const outcomeRace=await Promise.allSettled([service.execute(actor,outcome,"PAY",{...decision(2),...outcomeTime}),
        service.execute(actor,outcome,"FAIL",{...failure,...decision(2),external_transfer_id:"failed_"+randomUUID(),attempted_at:outcomeTime.transferred_at})]);
      outcomeRace.forEach(assertContender);assert.equal(outcomeRace.filter(r=>r.status==="fulfilled").length,1);
      assert.equal(await count("merchant_payout_receipt",outcome)+await count("merchant_payout_failure",outcome),1);

      const payReview=await approve("c_pay_reconcile_race"),payReviewTransfer=await transfer();
      const payReviewRace=await Promise.allSettled([service.execute(actor,payReview,"PAY",{...decision(2),...payReviewTransfer}),
        service.execute(actor,payReview,"RECONCILE",review(payReviewTransfer,"unknown_receipt",2,"review"))]);
      payReviewRace.forEach(assertContender);assert.equal(payReviewRace[0]?.status,"fulfilled");assert.equal(payReviewRace[1]?.status,"rejected");
      assert.equal((await row(payReview)).status,"PAID");assert.equal(await count("merchant_payout_reconciliation",payReview),0);
      const payReviewReceipt=await db("merchant_payout_receipt").where({payable_id:payReview}).first("id");assert.ok(payReviewReceipt);
      const reconcilers=await Promise.allSettled([service.execute(actor,payReview,"RECONCILE",review(payReviewTransfer,payReviewReceipt.id,3,"review_a")),
        service.execute(actor,payReview,"RECONCILE",review(payReviewTransfer,payReviewReceipt.id,3,"review_b"))]);
      reconcilers.forEach(assertContender);assert.equal(reconcilers.filter(r=>r.status==="fulfilled").length,1);
      assert.equal(await count("merchant_payout_reconciliation",payReview),1);

      const disputeRaceId=await approve("c_dispute_reconcile_race"),disputeRaceTransfer=await transfer();
      const disputeRaceReceipt=await service.execute(actor,disputeRaceId,"PAY",{...decision(2),...disputeRaceTransfer});
      const disputeRace=await Promise.allSettled([
        service.execute(actor,disputeRaceId,"DISCREPANCY",{...decision(3),category:"TRANSFER_DISPUTE",evidence_reference:"bank_dispute"}),
        service.execute(actor,disputeRaceId,"RECONCILE",review(disputeRaceTransfer,disputeRaceReceipt.receipt_id,3,"review"))]);
      disputeRace.forEach(assertContender);assert.equal(disputeRace.filter(r=>r.status==="fulfilled").length,1);
      const raceState=await row(disputeRaceId);
      if(raceState.status==="RECONCILED") {
        // A later separately confirmed assertion appends a discrepancy without
        // reversing the already committed reconciliation decision.
        await service.execute(actor,disputeRaceId,"DISCREPANCY",{...decision(4),category:"TRANSFER_DISPUTE",evidence_reference:"later_bank_dispute"});
        assert.equal((await row(disputeRaceId)).status,"RECONCILED");
      } else assert.equal(raceState.status,"PAID");
      assert.equal(await count("merchant_payout_receipt",disputeRaceId),1);assert.equal(await count("merchant_settlement_discrepancy",disputeRaceId),1);

      const attention=await service.attention(actor,{limit:25});assert.ok(attention.items.some(i=>i.id===disputed));
      const evidence=await service.evidence(actor,first);assert.equal(evidence.receipt?.beneficiary_reference,payment.beneficiary_reference);
      give();await assert.rejects(service.execute(actor,competingApproval,"PAY",{...decision(2),...await transfer()}),domain("forbidden"));
      await assert.rejects(service.evidence(actor,first),domain("forbidden"));all();

      // Atomic rollback at each independent persistence/audit boundary.
      const rollbackApproval=await makeReady("c_approval_rollback");
      const inject=async(table:string,body:string)=>{
        await db.raw(`create or replace function c_fixture_reject() returns trigger as $failure$ begin ${body} return NEW; end; $failure$ language plpgsql`);
        await db.raw(`create trigger c_fixture_reject before insert on ${table} for each row execute function c_fixture_reject()`);
      };
      await inject("merchant_settlement_command","if NEW.action='APPROVE' then raise exception 'Injected C approval audit failure'; end if;");
      await assert.rejects(service.execute(actor,rollbackApproval,"APPROVE",decision(1)),/Injected C approval audit failure/);
      assert.equal((await row(rollbackApproval)).status,"READY_FOR_APPROVAL");assert.equal(await count("merchant_settlement_command",rollbackApproval),0);
      await db.raw("drop trigger c_fixture_reject on merchant_settlement_command");
      await service.execute(actor,rollbackApproval,"APPROVE",decision(1));
      await inject("merchant_payout_failure","raise exception 'Injected C failed-attempt persistence failure';");
      await assert.rejects(service.execute(actor,rollbackApproval,"FAIL",{...failure,...decision(2),external_transfer_id:"new_failure_"+randomUUID(),attempted_at:(await transfer()).transferred_at}),/Injected C failed-attempt persistence failure/);
      assert.equal((await row(rollbackApproval)).status,"APPROVED");assert.equal(await count("merchant_payout_failure",rollbackApproval),0);assert.equal(await count("merchant_payout_identity",rollbackApproval),0);
      await db.raw("drop trigger c_fixture_reject on merchant_payout_failure");
      const rollbackTransfer=await transfer(),rollbackReceipt=await service.execute(actor,rollbackApproval,"PAY",{...decision(2),...rollbackTransfer});
      await inject("merchant_settlement_command","if NEW.action='RECONCILE' then raise exception 'Injected C reconciliation audit failure'; end if;");
      const rollbackReview=review(rollbackTransfer,rollbackReceipt.receipt_id,3,"review_rollback");
      await assert.rejects(service.execute(actor,rollbackApproval,"RECONCILE",rollbackReview),/Injected C reconciliation audit failure/);
      assert.equal((await row(rollbackApproval)).status,"PAID");assert.equal(await count("merchant_payout_reconciliation",rollbackApproval),0);
      await db.raw("drop trigger c_fixture_reject on merchant_settlement_command");
      await service.execute(actor,rollbackApproval,"RECONCILE",rollbackReview);

      // Deferred COMMIT proof: an approval audit without its matching state
      // transition cannot survive even when every immediate insert check passes.
      const incomplete=await makeReady("c_deferred_rollback");
      await assert.rejects(db.transaction(async trx=>{
        await trx("merchant_settlement_command").insert({id:"incomplete_"+randomUUID(),payable_id:incomplete,action:"APPROVE",actor_id:actor,
          prior_revision:1,new_revision:2,from_status:"READY_FOR_APPROVAL",to_status:"APPROVED",request_id:"incomplete_request_"+randomUUID(),
          request_fingerprint:"fixture",reason:"Deferred consistency negative control",confirmed:true,amount_minor:9000,currency:"zar"});
      }),/Payout audit\/state mismatch/);
      assert.equal((await row(incomplete)).status,"READY_FOR_APPROVAL");assert.equal(await count("merchant_settlement_command",incomplete),0);
      console.log("M20-C payout, failure, reconciliation and audit verification passed.");
    } finally {grants.forEach((key,i)=>{if(original[i]===undefined) delete process.env[key];else process.env[key]=original[i];});}
  });
}
