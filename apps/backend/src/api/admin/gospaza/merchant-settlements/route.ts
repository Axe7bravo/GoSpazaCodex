import { merchantSettlementHandler } from "../../../../lib/merchant-settlement-http";
import { settlementProjectionHandler } from "../../../../lib/settlement-projection-http";
export const GET=settlementProjectionHandler("platform-list");
export const POST=merchantSettlementHandler("generate");
