import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { notificationRuntimeSql } from "../notification-runtime-schema";
export class Migration20261113120000 extends Migration {
  async up(): Promise<void> { for (const sql of notificationRuntimeSql) this.addSql(sql); }
  async down(): Promise<void> { throw Error("Notification execution evidence cannot be destructively removed."); }
}
