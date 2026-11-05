import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { driverCompensationSql, driverCompensationAssignmentSql } from "../driver-compensation-schema";

export class Migration20261108120000 extends Migration {
  async up(): Promise<void> {
    for (const sql of [...driverCompensationSql, ...driverCompensationAssignmentSql]) this.addSql(sql);
  }
  async down(): Promise<void> { throw new Error("Driver compensation history cannot be destructively rolled back."); }
}
