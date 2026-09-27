import { randomUUID } from "node:crypto";
import { createStep, createWorkflow, StepResponse, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk";
import { createCustomerAddressesWorkflow, updateCustomerAddressesWorkflow } from "@medusajs/medusa/core-flows";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { AddressInput } from "../modules/marketplace/location-policy";

const record = createStep("gospaza-record-address-location", async (
  input: { id: string; location: AddressInput["location"] }, { container },
) => {
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  await db.transaction(async (trx) => {
    if (!input.location) {
      await trx("customer_address_location").where({ medusa_customer_address_id: input.id }).delete();
      return;
    }
    await trx("customer_address_location").insert({
      id: "caloc_" + randomUUID(), medusa_customer_address_id: input.id, ...input.location,
    }).onConflict("medusa_customer_address_id").merge({ ...input.location, updated_at: new Date(), deleted_at: null });
  });
  return new StepResponse(input.id);
});
type Input = { customerId: string; data: AddressInput };
export const createAddressLocationWorkflow = createWorkflow("gospaza-create-address-location", (input: Input) => {
  const addresses = createCustomerAddressesWorkflow.runAsStep({ input: transform(input, ({ customerId, data }) => {
    const fields = { first_name: data.first_name, last_name: data.last_name, address_1: data.address_1,
      address_2: data.address_2, city: data.city, province: data.province, postal_code: data.postal_code,
      country_code: data.country_code, phone: data.phone };
    return { addresses: [{ ...fields, customer_id: customerId }] };
  }) });
  return new WorkflowResponse(record(transform({ addresses, input }, ({ addresses, input }) => ({
    id: addresses[0]!.id, location: input.data.location,
  }))));
});
export const updateAddressLocationWorkflow = createWorkflow("gospaza-update-address-location", (input: Input & { id: string }) => {
  const addresses = updateCustomerAddressesWorkflow.runAsStep({ input: transform(input, ({ customerId, id, data }) => {
    const fields = { first_name: data.first_name, last_name: data.last_name, address_1: data.address_1,
      address_2: data.address_2, city: data.city, province: data.province, postal_code: data.postal_code,
      country_code: data.country_code, phone: data.phone };
    return { selector: { id, customer_id: customerId }, update: fields };
  }) });
  return new WorkflowResponse(record(transform({ addresses, input }, ({ addresses, input }) => ({
    id: addresses[0]!.id, location: input.data.location,
  }))));
});
