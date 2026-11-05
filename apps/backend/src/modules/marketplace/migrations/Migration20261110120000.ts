import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { driverPaymentSql } from "../driver-payment-schema";
export class Migration20261110120000 extends Migration {
  async up(): Promise<void> { for (const sql of driverPaymentSql) this.addSql(sql); }
  async down(): Promise<void> { throw new Error("Driver payment history cannot be destructively rolled back."); }
}
