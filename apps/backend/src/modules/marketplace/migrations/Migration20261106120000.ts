import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { merchantSettlementSql } from "../merchant-settlement-schema";
export class Migration20261106120000 extends Migration {
  async up():Promise<void> { for(const sql of merchantSettlementSql) this.addSql(sql); }
  async down():Promise<void> { throw new Error("M20 settlement evidence cannot be destructively rolled back."); }
}

