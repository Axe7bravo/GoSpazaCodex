import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { notificationSql } from "../notification-schema";

export class Migration20261111120000 extends Migration {
  async up(): Promise<void> { for (const sql of notificationSql) this.addSql(sql); }
  async down(): Promise<void> { throw new Error("Notification evidence cannot be destructively rolled back."); }
}
