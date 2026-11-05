import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { driverEarningSql } from "../driver-earning-schema";
export class Migration20261109120000 extends Migration {
  async up(): Promise<void> { for (const sql of driverEarningSql) this.addSql(sql); }
  async down(): Promise<void> { throw new Error("Driver earning history cannot be destructively rolled back."); }
}
