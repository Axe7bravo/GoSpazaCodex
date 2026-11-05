import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { merchantPayoutSql } from "../merchant-payout-schema";
export class Migration20261107120000 extends Migration {
  async up():Promise<void> {for(const sql of merchantPayoutSql) this.addSql(sql);}
  async down():Promise<void> {throw new Error("M20 payout evidence cannot be destructively rolled back.");}
}
