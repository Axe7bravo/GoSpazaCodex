import assert from "node:assert/strict";
import type { ExecArgs, IInventoryService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { Modules,ContainerRegistrationKeys } from "@medusajs/framework/utils";
import verifyRecipient from "./verify-recipient";
import { ReturnedInventory } from "../lib/returned-inventory";
import { OmissionReservations } from "../lib/omission-reservations";
import { pickupInput } from "../modules/marketplace/pickup-policy";

export default async function verifyReturnedInventory(args:ExecArgs) {
  if(process.env.OMISSION_RESERVATION_WORKER_ENABLED==="true") throw new Error("Disable omission worker in backend and verifier during fixture verification.");
  await verifyRecipient(args,async(f,id)=>{
    const {container}=f.fixture, db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const inventory=container.resolve<IInventoryService>(Modules.INVENTORY);
    const ship=await db("pickup_operation").where({delivery_id:id,action:"SHIP",state:"SUCCEEDED"}).first();
    const source=pickupInput.parse(ship.input);
    const line=source.items[0]; assert.ok(line);
    const component=source.components.find(c=>c.line_item_id===line.id && c.inventory_item_id); assert.ok(component?.inventory_item_id);
    const item=component.inventory_item_id;
    const stock=async()=>{
      const levels=await inventory.listInventoryLevels({inventory_item_id:item,location_id:source.location_id});
      assert.equal(levels.length,1);return Number(levels[0]?.stocked_quantity);
    };
    const path="/merchant/deliveries/"+id+"/dispositions";
    f.expect(await f.http(f.ownerB.cookie,"GET",path),404);
    f.expect(await f.http(f.picker.cookie,"GET",path),403);
    f.expect(await f.http(f.manager.cookie,"GET",path));
    f.expect(await f.http(f.ownerA.cookie,"POST",path,{line_id:line.id,decision:"RESTOCK",confirmed:true,quantity:99999}),400);
    const rollback=new Error("C2B isolated disposition proof");
    for(const decision of ["NON_SELLABLE","RESTOCK"] as const) {
      await assert.rejects(db.transaction(async trx=>{
        const service=new ReturnedInventory(container,trx), before=await stock();
        const command={line_id:line.id,confirmed:true,decision};
        const result=await service.handle(f.ownerA.identity,id,command);
        assert.ok("status" in result && result.status==="COMPLETED");
        await service.handle(f.manager.identity,id,command);
        await assert.rejects(service.handle(f.manager.identity,id,{...command,decision:decision==="RESTOCK" ? "NON_SELLABLE":"RESTOCK"}));
        assert.equal(await stock(),before+(decision==="RESTOCK" ? component.quantity:0));
        const disposition=await trx("returned_inventory_disposition").where({fulfillment_id:source.fulfillment_id,line_id:line.id}).first();
        assert.equal(disposition.quantity,line.quantity);
        assert.equal((await trx("returned_inventory_event").where({disposition_id:disposition.id,status:"COMPLETED"})).length,1);
        throw rollback;
      }),error=>error===rollback);
    }
    await assert.rejects(db.transaction(async trx=>{
      const resolution=await trx("shortage_resolution as s").join("pick_line as l","l.id","s.pick_line_id")
        .where({"l.medusa_order_line_id":line.id,"s.status":"RESOLVED_OMITTED"}).whereNull("s.invalidated_at").select("s.id").first();
      assert.ok(resolution);
      const before=await stock();
      const release=new OmissionReservations(container,trx);
      await release.reconcile(resolution.id);
      await release.reconcile(resolution.id);
      const rows=await trx("omission_reservation_release").where({resolution_id:resolution.id});
      assert.equal(rows.length,1);
      assert.equal(rows[0].status,"COMPLETED");
      assert.equal((await inventory.listReservationItems({line_item_id:line.id})).length,0);
      assert.equal(await stock(),before);
      throw rollback;
    }),error=>error===rollback);
  });
  console.log("C2B return disposition passed: real M17 custody, tenant/role isolation, exact matched native stock delta and replay.");
}
