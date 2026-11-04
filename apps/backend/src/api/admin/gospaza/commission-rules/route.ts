import { commissionHandler } from "../../../../lib/commission-http";
export const GET = commissionHandler("history");
export const POST = commissionHandler("publish");
