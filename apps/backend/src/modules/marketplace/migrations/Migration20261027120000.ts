import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261027120000 extends Migration {
  async up(): Promise<void> {
    // Forward repair for already-applied M17-C schemas. Keep all trigger
    // attachments, timing and predicates; separate PL/pgSQL records from aliases.
    this.addSql(`
      create or replace function gospaza_recipient_consistency() returns trigger language plpgsql as $$
      declare
        target_delivery_id text;
        delivery_row delivery_operation;
        commitment_row dispatch_commitment;
        return_row restricted_return;
        recipient_row recipient_compliance;
      begin
        if TG_TABLE_NAME='delivery_operation' then target_delivery_id:=new.id;
        elsif TG_TABLE_NAME in ('recipient_compliance','restricted_return','delivery_completion','dispatch_commitment') then target_delivery_id:=new.delivery_id;
        else raise exception 'Unsupported recipient consistency table'; end if;
        select delivery.* into delivery_row from delivery_operation as delivery where delivery.id=target_delivery_id;
        if not found then return null; end if;
        for recipient_row in select recipient.* from recipient_compliance as recipient where recipient.delivery_id=target_delivery_id loop
          if not delivery_row.restricted_content_present or delivery_row.arrived_at is null
            or not exists(select 1 from dispatch_commitment as commitment where commitment.id=recipient_row.commitment_id and commitment.delivery_id=target_delivery_id and commitment.driver_profile_id=recipient_row.driver_profile_id)
            or not exists(select 1 from handoff_generation as generation where generation.id=recipient_row.generation_id and generation.delivery_id=target_delivery_id)
            or not exists(select 1 from restricted_delivery_document as document where document.id=recipient_row.document_id and document.order_operation_id=delivery_row.order_operation_id and document.medusa_order_id=delivery_row.medusa_order_id)
            or not exists(select 1 from restricted_event as audit where audit.target_id=recipient_row.id and audit.action='RECIPIENT_'||recipient_row.outcome)
            then raise exception 'Recipient authority mismatch'; end if;
          if recipient_row.outcome='FAILED' and not exists(select 1 from restricted_return as custody where custody.compliance_id=recipient_row.id)
            then raise exception 'Failed handoff retains custody'; end if;
        end loop;
        select custody.* into return_row from restricted_return as custody where custody.delivery_id=target_delivery_id;
        if return_row.id is not null then
          select commitment.* into commitment_row from dispatch_commitment as commitment where commitment.id=return_row.commitment_id;
          select recipient.* into recipient_row from recipient_compliance as recipient where recipient.id=return_row.compliance_id;
          if recipient_row.outcome is distinct from 'FAILED' or recipient_row.delivery_id<>target_delivery_id
            or recipient_row.commitment_id<>commitment_row.id or commitment_row.delivery_id<>target_delivery_id
            or return_row.merchant_store_id<>delivery_row.merchant_store_id or return_row.fulfillment_id is distinct from delivery_row.native_fulfillment_id
            or exists(select 1 from delivery_completion as completion where completion.delivery_id=target_delivery_id)
            or not exists(select 1 from pickup_operation as pickup where pickup.delivery_id=target_delivery_id and pickup.action='SHIP' and pickup.state='SUCCEEDED' and pickup.input->'items'=return_row.physical_manifest)
            then raise exception 'Return authority mismatch'; end if;
          if return_row.state='RETURNED_TO_STORE' then
            if commitment_row.status<>'RETURNED' or delivery_row.status<>'RETURNED_TO_STORE'
              or not exists(select 1 from merchant_member as member where member.id=return_row.received_by and member.merchant_id=delivery_row.merchant_id)
              or not exists(select 1 from restricted_event as audit where audit.target_id=return_row.id and audit.action='STORE_RECEIPT_ACKNOWLEDGED' and audit.actor_id=return_row.received_by)
              or not exists(select 1 from dispatch_event as audit where audit.target_id=target_delivery_id and audit.action='RETURNED_TO_STORE' and audit.revision=delivery_row.revision)
              then raise exception 'Two-sided return receipt required'; end if;
          elsif commitment_row.status<>'ASSIGNED' or delivery_row.status not in ('ASSIGNED','ATTENTION_REQUIRED')
            then raise exception 'Return must retain driver capacity'; end if;
        elsif delivery_row.status='RETURNED_TO_STORE' or exists(select 1 from dispatch_commitment as commitment where commitment.delivery_id=target_delivery_id and commitment.status='RETURNED')
          then raise exception 'Return receipt required'; end if;
        if delivery_row.restricted_content_present and exists(
          select 1 from delivery_completion as completion where completion.delivery_id=target_delivery_id and not exists(
            select 1 from recipient_compliance as verified_recipient
            where verified_recipient.delivery_id=target_delivery_id and verified_recipient.commitment_id=completion.commitment_id
              and verified_recipient.generation_id=completion.generation_id and verified_recipient.outcome='SATISFIED'))
          then raise exception 'Restricted completion requires recipient evidence'; end if;
        return null;
      end $$;
    `);
  }

  async down(): Promise<void> {
    throw new Error("Do not restore the ambiguous recipient trigger; use a forward corrective migration.");
  }
}
