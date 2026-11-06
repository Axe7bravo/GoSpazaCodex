import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { notificationMappingSql } from "../notification-mapping-schema";
export class Migration20261112120000 extends Migration {
  async up(): Promise<void> { for (const sql of notificationMappingSql) this.addSql(sql); }
  async down(): Promise<void> { throw new Error("Notification audience history cannot be destructively removed."); }
}
